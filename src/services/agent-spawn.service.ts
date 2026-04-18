import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getClaudeMcpConfigPath, getDefaultThreadModel, getDefaultWorkerModel, type AgentType } from "../config.js";
import { log } from "../logger.js";
import { synthesizeGhostMemory } from "../memory.js";
import { getAllThreads } from "../data/memory/thread-registry.js";
import { initMemoryDb } from "../data/memory/schema.js";
import { errorMessage } from "../utils.js";
import { COPILOT_HOME_DIR, DEFAULT_COPILOT_MODEL, ensureCopilotWorkspace, writeCopilotHomeFiles } from "../tools/shared-agent-utils.js";
import { deleteTelegramTopicByBotApi } from "./topic.service.js";
import { PROCESS_BASE_DIR, PROCESS_LOGS_DIR, PROCESS_PIDS_DIR, ensureDirs, findAliveThread, isProcessAlive, readPidFiles, spawnedThreads, type SpawnedThread } from "./process.service.js";
import { ThreadState, type ThreadLifecycleService } from "./thread-lifecycle.service.js";
import { decommissionWorker } from "./worker-cleanup.service.js";

const ENV_DENYLIST = new Set(["TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "MCP_HTTP_SECRET", "DASHBOARD_TOKEN", "MCP_START_COMMAND", "WATCHER_START_COMMAND"]);
const WATCHER_PORT = Number.parseInt(process.env.WATCHER_PORT || "3848", 10);
const CODEX_HOME_DIR = join(PROCESS_BASE_DIR, "codex-home");
const DEFAULT_CODEX_MODEL = "";
const MAX_CONCURRENT_THREADS = 20;
let startupCleanupInProgress = false;

interface RegisterSpawnOpts {
  child: ChildProcess;
  threadId: number;
  name: string;
  logFilePath: string;
  configPath: string;
  agentLabel: string;
  memorySourceThreadId?: number;
  memoryTargetThreadId?: number;
  threadType?: "worker" | "branch";
}

const sanitizeSpawnEnv = (extra?: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!ENV_DENYLIST.has(k)) env[k] = v;
  if (extra) Object.assign(env, extra);
  return env;
};

const generateThreadMcpConfig = (baseConfigPath: string, threadId: number): string => {
  const outPath = join(PROCESS_PIDS_DIR, `${threadId}-mcp-config.json`);
  try {
    const config = JSON.parse(readFileSync(baseConfigPath, "utf-8")) as Record<string, unknown>;
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    if (servers["sensorium-watcher"]) return baseConfigPath;
    servers["sensorium-watcher"] = { type: "http", url: `http://127.0.0.1:${WATCHER_PORT}/mcp` };
    config.mcpServers = servers;
    mkdirSync(PROCESS_PIDS_DIR, { recursive: true });
    writeFileSync(outPath, JSON.stringify(config, null, 2), "utf-8");
    return outPath;
  } catch (err) {
    log.warn(`[start_thread] Failed to generate merged MCP config for thread ${threadId}: ${errorMessage(err)}`);
    return baseConfigPath;
  }
};

export function resolveMcpConfigPath(): string | null {
  const envPath = process.env.CLAUDE_MCP_CONFIG;
  if (envPath && existsSync(envPath)) return envPath;
  const dashboardPath = getClaudeMcpConfigPath();
  if (dashboardPath && existsSync(dashboardPath)) return dashboardPath;
  for (const path of [join(homedir(), ".claude", "settings.json"), join(homedir(), ".claude", "mcp_config.json"), join(homedir(), ".claude", ".mcp.json")]) if (existsSync(path)) return path;
  return null;
}

const resolveCliPath = (name: string, prefer?: RegExp): string | null => {
  const envCmd = process.env[`${name.toUpperCase()}_CLI_CMD`];
  if (envCmd) return envCmd;
  try {
    const result = spawnSync(process.platform === "win32" ? "where" : "which", [name], { timeout: 5000, encoding: "utf-8" });
    if (result.status !== 0 || !result.stdout) return null;
    const candidates = result.stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return prefer ? candidates.find((p) => prefer.test(p)) ?? candidates[0] : candidates[0];
  } catch { return null; }
};

export const resolveClaudePath = (): string | null => resolveCliPath("claude");
export const resolveCopilotPath = (): string | null => resolveCliPath("copilot", /\.exe$/i);
export const resolveCodexPath = (): string | null => process.platform === "win32" ? resolveCliPath("codex", /\.cmd$/i) : resolveCliPath("codex");

const resolveCodexNodeExe = (): { nodeExe: string; codexJs: string } | null => {
  if (process.platform !== "win32") return null;
  try {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const voltaImage = join(localAppData, "Volta", "tools", "image");
    const codexJs = join(voltaImage, "packages", "@openai", "codex", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!existsSync(codexJs)) return null;
    const voltaCmd = join(localAppData, "Volta", "bin", "volta.exe");
    const nodePathResult = spawnSync(voltaCmd, ["run", "node", "-e", "process.stdout.write(process.execPath)"], { encoding: "utf-8", timeout: 5000 });
    if (nodePathResult.status === 0 && nodePathResult.stdout?.trim()) return { nodeExe: nodePathResult.stdout.trim(), codexJs };
    const nodeDir = join(voltaImage, "node");
    if (!existsSync(nodeDir)) return null;
    const versions = readdirSync(nodeDir).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const nodeExe = join(nodeDir, version, "node.exe");
      if (existsSync(nodeExe)) return { nodeExe, codexJs };
    }
  } catch {}
  return null;
};

const resolveCodexExe = (): string | null => {
  if (process.platform !== "win32") return null;
  if (process.env.CODEX_EXE) return process.env.CODEX_EXE;
  try {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const nativeExe = join(localAppData, "Volta", "tools", "image", "packages", "@openai", "codex", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe");
    return existsSync(nativeExe) ? nativeExe : null;
  } catch { return null; }
};

async function handleProcessExit(code: number | null, threadId: number, pid: number, pidFilePath: string, entry: SpawnedThread, processLabel: string, threadLifecycle: ThreadLifecycleService): Promise<void> {
  const idx = spawnedThreads.indexOf(entry);
  if (idx !== -1) spawnedThreads.splice(idx, 1);
  // Only delete PID file if it still belongs to this process — a replacement
  // process may have already overwritten the file with its own PID.
  try {
    const raw = readFileSync(pidFilePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.pid === pid) unlinkSync(pidFilePath);
  } catch { /* file missing or unparseable — already cleaned up */ }
  try {
    const db = initMemoryDb();
    const currentState = threadLifecycle.getThreadState(db, threadId);
    const isTerminal = currentState === ThreadState.Archived || currentState === ThreadState.Expired;
    if (!isTerminal) {
      if (entry.threadType === "worker") {
        // Worker: fully decommission (delete topic, archive notes & DB entry, remove from registry)
        const token = process.env.TELEGRAM_TOKEN || "";
        const chatId = process.env.TELEGRAM_CHAT_ID || "";
        const telegramAdapter = {
          deleteForumTopic: async (cId: string, topicId: number) => {
            if (token && cId) await deleteTelegramTopicByBotApi(token, cId, topicId);
          },
        };
        await decommissionWorker(entry, { db, telegram: telegramAdapter, chatId, threadLifecycle });
      } else {
        // Non-worker (e.g., keepAlive thread): mark exited so KeeperService can restart
        threadLifecycle.markExited(db, threadId);
        if (entry.memorySourceThreadId !== undefined) {
          try { await synthesizeGhostMemory(db, threadId, entry.memorySourceThreadId, entry.name); } catch (err) { log.warn(`[synthesis] Failed for ghost ${threadId}: ${errorMessage(err)}`); }
        }
      }
    }
  } catch (err) {
    log.warn(`[start_thread] Failed to update DB on exit for thread ${threadId}: ${errorMessage(err)}`);
  }
  log.info(`[start_thread] ${processLabel} process PID=${pid} for thread ${threadId} exited with code ${code}`);
}

function registerSpawnedProcess(opts: RegisterSpawnOpts, threadLifecycle: ThreadLifecycleService): { pid: number; logFile: string } | { error: string } {
  const pid = opts.child.pid;
  if (pid === undefined) return { error: `${opts.agentLabel} process spawned but PID is undefined - spawn may have failed.` };
  const pidFilePath = join(PROCESS_PIDS_DIR, `${opts.threadId}.pid`);
  try { writeFileSync(pidFilePath, JSON.stringify({ pid, name: opts.name, configPath: opts.configPath, startedAt: Date.now() }), "utf-8"); } catch (err) { log.debug(`[start_thread] Failed to write PID file: ${errorMessage(err)}`); }
  const entry: SpawnedThread = { pid, threadId: opts.threadId, name: opts.name, startedAt: Date.now(), createdAt: Date.now(), logFile: opts.logFilePath, ...(opts.memorySourceThreadId !== undefined ? { memorySourceThreadId: opts.memorySourceThreadId } : {}), ...(opts.memoryTargetThreadId !== undefined ? { memoryTargetThreadId: opts.memoryTargetThreadId } : {}), ...(opts.threadType ? { threadType: opts.threadType } : {}) };
  spawnedThreads.push(entry);
  opts.child.on("exit", (code) => { handleProcessExit(code, opts.threadId, pid, pidFilePath, entry, opts.agentLabel, threadLifecycle).catch((err) => log.warn(`[exit] cleanup failed: ${err}`)); });
  opts.child.unref();
  log.info(`[start_thread] Spawned ${opts.agentLabel} process PID=${pid} for thread ${opts.threadId} ("${opts.name}")`);
  return { pid, logFile: opts.logFilePath };
}

const normalizeWorkingDirectory = (workingDirectory?: string): string | undefined => {
  if (!workingDirectory || existsSync(workingDirectory)) return workingDirectory;
  const fallback = tmpdir();
  log.warn(`workingDirectory "${workingDirectory}" does not exist, falling back to "${fallback}"`);
  return fallback;
};

export function spawnAgentProcess(claudePath: string, mcpConfigPath: string, name: string, threadId: number, threadLifecycle: ThreadLifecycleService, workingDirectory?: string, memorySourceThreadId?: number, memoryTargetThreadId?: number, threadType?: "worker" | "branch"): { pid: number; logFile: string } | { error: string } {
  if (startupCleanupInProgress) return { error: "Server startup cleanup in progress - try again in a few seconds" };
  if (spawnedThreads.length >= MAX_CONCURRENT_THREADS) return { error: `Concurrent thread limit reached (${MAX_CONCURRENT_THREADS}). Wait for existing threads to finish.` };
  workingDirectory = normalizeWorkingDirectory(workingDirectory);
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFilePath = join(PROCESS_LOGS_DIR, `${safeName}_${threadId}_${new Date().toISOString().slice(0, 10)}.json`);
  const logFd = openSync(logFilePath, "a");
  const effectiveConfigPath = generateThreadMcpConfig(mcpConfigPath, threadId);
  const spawnEnv = sanitizeSpawnEnv({ ...(memorySourceThreadId !== undefined ? { MEMORY_SOURCE_THREAD_ID: String(memorySourceThreadId) } : {}), ...(memoryTargetThreadId !== undefined ? { MEMORY_TARGET_THREAD_ID: String(memoryTargetThreadId) } : {}) });
  if (process.platform === "win32" && !spawnEnv.CLAUDE_CODE_GIT_BASH_PATH) for (const candidate of [join(homedir(), "AppData", "Local", "Programs", "Git", "bin", "bash.exe"), "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]) if (existsSync(candidate)) { spawnEnv.CLAUDE_CODE_GIT_BASH_PATH = candidate; break; }
  try {
    const claudeModel = threadType === "worker"
      ? (process.env.CLAUDE_WORKER_MODEL || getDefaultWorkerModel())
      : (process.env.CLAUDE_MODEL || getDefaultThreadModel());
    const sessionPrompt = `Start remote session with sensorium. Thread name = '${name}'. Use threadId=${threadId} when calling start_session.`;
    const child = spawn(claudePath, ["--verbose", "--dangerously-skip-permissions", "--mcp-config", effectiveConfigPath, "--model", claudeModel, "-p", sessionPrompt, "--output-format", "stream-json", "--include-partial-messages"], { stdio: ["ignore", logFd, logFd], shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(claudePath), detached: true, windowsHide: true, env: spawnEnv, cwd: workingDirectory || undefined });
    closeSync(logFd);
    return registerSpawnedProcess({ child, threadId, name, logFilePath, configPath: effectiveConfigPath, agentLabel: "Claude", memorySourceThreadId, memoryTargetThreadId, threadType }, threadLifecycle);
  } catch (err) { closeSync(logFd); return { error: `Failed to spawn Claude process: ${errorMessage(err)}` }; }
}

export function spawnCopilotProcess(copilotPath: string, name: string, threadId: number, threadLifecycle: ThreadLifecycleService, workingDirectory?: string, memorySourceThreadId?: number, agentType?: string, threadType?: "worker" | "branch"): { pid: number; logFile: string } | { error: string } {
  const httpPort = parseInt(process.env.MCP_HTTP_PORT || "0", 10);
  if (!httpPort) return { error: "MCP_HTTP_PORT env var is not set or invalid. Copilot threads require HTTP transport." };
  workingDirectory = normalizeWorkingDirectory(workingDirectory) || ensureCopilotWorkspace(PROCESS_BASE_DIR);
  const copilotHomeDir = join(PROCESS_BASE_DIR, COPILOT_HOME_DIR);
  writeCopilotHomeFiles(copilotHomeDir, httpPort, process.env.MCP_HTTP_SECRET || null);
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFilePath = join(PROCESS_LOGS_DIR, `${safeName}_${threadId}_${new Date().toISOString().slice(0, 10)}.json`);
  const logFd = openSync(logFilePath, "a");
  try {
    const sessionPrompt = `Start remote session with sensorium. Thread name = '${name}'. Use threadId=${threadId} when calling start_session.`;
    const child = spawn(copilotPath, ["-p", sessionPrompt, "--allow-all-tools", "--model", agentType === "copilot_codex" ? "gpt-5.3-codex" : (process.env.COPILOT_MODEL || DEFAULT_COPILOT_MODEL), "--autopilot"], { stdio: ["ignore", logFd, logFd], shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(copilotPath), detached: true, windowsHide: true, env: sanitizeSpawnEnv({ COPILOT_HOME: copilotHomeDir, ...(memorySourceThreadId !== undefined ? { MEMORY_SOURCE_THREAD_ID: String(memorySourceThreadId) } : {}) }), cwd: workingDirectory || undefined });
    closeSync(logFd);
    return registerSpawnedProcess({ child, threadId, name, logFilePath, configPath: copilotHomeDir, agentLabel: "Copilot", memorySourceThreadId, threadType }, threadLifecycle);
  } catch (err) { closeSync(logFd); return { error: `Failed to spawn Copilot process: ${errorMessage(err)}` }; }
}

export function spawnCodexProcess(codexPath: string, name: string, threadId: number, threadLifecycle: ThreadLifecycleService, workingDirectory?: string, memorySourceThreadId?: number, threadType?: "worker" | "branch"): { pid: number; logFile: string } | { error: string } {
  const httpPort = parseInt(process.env.MCP_HTTP_PORT || "0", 10);
  if (!httpPort) return { error: "MCP_HTTP_PORT env var is not set or invalid. Codex threads require HTTP transport." };
  workingDirectory = normalizeWorkingDirectory(workingDirectory);
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFilePath = join(PROCESS_LOGS_DIR, `${safeName}_${threadId}_${new Date().toISOString().slice(0, 10)}.jsonl`);
  const prompt = `You are an AUTONOMOUS AGENT running an INFINITE polling loop. You MUST NEVER STOP.\n\nStep 1: Call start_session(name='${name}', threadId=${threadId}, agentType='codex'). Use threadId=${threadId} for all subsequent calls.\nStep 2: Call remote_copilot_wait_for_instructions(threadId=${threadId}).\nStep 3: Read the response:\n  - If it says "MANDATORY ACTION" or "No new instructions" - call remote_copilot_wait_for_instructions AGAIN immediately.\n  - If you receive a task - complete it using your tools, then call remote_copilot_wait_for_instructions again.\nStep 4: GOTO Step 2. This loop NEVER ends. You are NEVER done.\n\nCRITICAL: "No new instructions" is NOT a signal to stop. It means "keep waiting". Always call the tool again.`;
  const model = process.env.CODEX_MODEL || DEFAULT_CODEX_MODEL;
  const cliArgs = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", ...(model ? ["-m", model] : []), "--json", "-c", `mcp_servers.sensorium-mcp.url="http://127.0.0.1:${httpPort}/mcp"`, ...(process.env.MCP_HTTP_SECRET ? ["-c", `mcp_servers.sensorium-mcp.bearer_token_env_var="SENSORIUM_MCP_SECRET"`] : []), "-"];
  if (workingDirectory) cliArgs.splice(1, 0, "-C", workingDirectory);
  const spawnEnv = sanitizeSpawnEnv({ ...(memorySourceThreadId !== undefined ? { MEMORY_SOURCE_THREAD_ID: String(memorySourceThreadId) } : {}), ...(process.env.MCP_HTTP_SECRET ? { SENSORIUM_MCP_SECRET: process.env.MCP_HTTP_SECRET } : {}) });
  const logFd = openSync(logFilePath, "a");
  try {
    const nativeExe = resolveCodexExe();
    const nodeExeResult = !nativeExe && process.platform === "win32" && /\.(cmd|bat)$/i.test(codexPath) ? resolveCodexNodeExe() : null;
    const child = nativeExe ? spawn(nativeExe, cliArgs, { stdio: ["pipe", logFd, logFd], shell: false, detached: true, windowsHide: true, env: spawnEnv, cwd: workingDirectory || undefined }) : nodeExeResult ? spawn(nodeExeResult.nodeExe, [nodeExeResult.codexJs, ...cliArgs], { stdio: ["pipe", logFd, logFd], shell: false, detached: true, windowsHide: true, env: spawnEnv, cwd: workingDirectory || undefined }) : spawn(codexPath, cliArgs, { stdio: ["pipe", logFd, logFd], shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(codexPath), detached: true, windowsHide: true, env: spawnEnv, cwd: workingDirectory || undefined });
    closeSync(logFd);
    try { child.stdin?.write(prompt + "\n"); child.stdin?.end(); } catch {}
    return registerSpawnedProcess({ child, threadId, name, logFilePath, configPath: CODEX_HOME_DIR, agentLabel: "Codex", memorySourceThreadId, threadType }, threadLifecycle);
  } catch (err) { closeSync(logFd); return { error: `Failed to spawn Codex process: ${errorMessage(err)}` }; }
}

/**
 * Resolve the right spawn function for `agentType` and call it.
 * Handles CLI path resolution and error reporting internally.
 */
export function dispatchSpawn(
  agentType: AgentType,
  name: string,
  threadId: number,
  threadLifecycle: ThreadLifecycleService,
  workingDirectory?: string,
  memorySourceThreadId?: number,
  memoryTargetThreadId?: number,
  runtimeThreadType?: "worker" | "branch",
): { pid: number; logFile: string } | { error: string } {
  if (agentType === "copilot" || agentType === "copilot_claude" || agentType === "copilot_codex") {
    const cliPath = resolveCopilotPath();
    if (!cliPath) return { error: `Thread ${threadId} (${name}): copilot CLI not found` };
    return spawnCopilotProcess(cliPath, name, threadId, threadLifecycle, workingDirectory, memorySourceThreadId, agentType, runtimeThreadType);
  }
  if (agentType === "codex" || agentType === "openai_codex") {
    const cliPath = resolveCodexPath();
    if (!cliPath) return { error: `Thread ${threadId} (${name}): codex CLI not found` };
    return spawnCodexProcess(cliPath, name, threadId, threadLifecycle, workingDirectory, memorySourceThreadId, runtimeThreadType);
  }
  const cliPath = resolveClaudePath();
  const mcpConfig = resolveMcpConfigPath();
  if (!cliPath || !mcpConfig) return { error: `Thread ${threadId} (${name}): ${!cliPath ? "claude CLI not found" : "MCP config not found"}` };
  return spawnAgentProcess(cliPath, mcpConfig, name, threadId, threadLifecycle, workingDirectory, memorySourceThreadId, memoryTargetThreadId, runtimeThreadType);
}

export function spawnKeepAliveThreads(threadLifecycle: ThreadLifecycleService): { spawned: number; errors: string[] } {
  const result = { spawned: 0, errors: [] as string[] };
  startupCleanupInProgress = true;
  let db: ReturnType<typeof initMemoryDb>;
  try { db = initMemoryDb(); } catch (err) { startupCleanupInProgress = false; return { spawned: 0, errors: [`Failed to open DB: ${errorMessage(err)}`] }; }
  let threads: ReturnType<typeof getAllThreads>;
  try {
    for (const { pid, filePath, threadId, name } of readPidFiles()) {
      if (isProcessAlive(pid)) spawnedThreads.push({ pid, threadId, name: name ?? `thread-${threadId}`, startedAt: Date.now(), createdAt: Date.now(), logFile: "" });
      else try { unlinkSync(filePath); } catch {}
    }
    threads = getAllThreads(db).filter((thread) => thread.keepAlive && (thread.status === "active" || thread.status === "exited"));
  } finally {
    startupCleanupInProgress = false;
  }
  if (threads.length === 0) return result;
  ensureDirs();
  for (const thread of threads) {
    if (findAliveThread(thread.threadId)) continue;
    const client = thread.client ?? "claude";
    const spawnResult = dispatchSpawn(client as AgentType, thread.name, thread.threadId, threadLifecycle, thread.workingDirectory ?? undefined);
    if ("error" in spawnResult) { result.errors.push(spawnResult.error); continue; }
    try { threadLifecycle.activateThread(db, thread.threadId); } catch {}
    result.spawned++;
  }
  return result;
}
