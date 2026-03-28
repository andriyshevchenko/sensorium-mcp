/**
 * Claude CLI keeper — spawns and auto-restarts a Claude agent for always-on sessions.
 *
 * Integrates with watcher-service.ts. After the MCP HTTP server is ready, the keeper
 * spawns the Claude CLI pointed at the MCP server and monitors it:
 *   - Process exit → schedule restart with exponential backoff
 *   - HTTP liveness check → force-restart if agent stops polling
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const LIVENESS_CHECK_INTERVAL_MS = 5 * 60_000;
/** Minimum uptime before a restart is considered "healthy" and retry count resets. */
const HEALTHY_UPTIME_MS = 60_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_COOLDOWN_MS = 300_000;
const WARM_CONTEXT_LINE_LIMIT = 50;
const WARM_CONTEXT_TEXT_LIMIT = 200;
const MCP_READY_POLL_INTERVAL_MS = 3_000;
const MCP_READY_TIMEOUT_MS = 120_000;

// WAIT_TIMEOUT_MINUTES can be up to 120 min — allow full cycle + buffer before flagging dead
const rawWaitTimeout = parseInt(process.env.WAIT_TIMEOUT_MINUTES ?? "120", 10);
const LIVENESS_THRESHOLD_MS = (Math.max(1, rawWaitTimeout) + 10) * 60_000;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface KeeperConfig {
  /** Telegram thread ID of the always-on session. */
  threadId: number;
  /** Human-readable session name passed to start_session. */
  sessionName: string;
  /** Path to the `claude` binary (default: "claude"). */
  claudeCmd: string;
  /** Path where the keeper writes its MCP config JSON. */
  mcpConfigPath: string;
  /** Port of the sensorium MCP HTTP server. */
  mcpHttpPort: number;
  /** Bearer token for MCP HTTP auth, or null if unauthenticated. */
  mcpHttpSecret: string | null;
  /** ~/.remote-copilot-mcp data directory. */
  dataDir: string;
  /** Max consecutive fast crashes before entering cooldown. Default: 5. */
  maxRetries?: number;
  /** Cooldown duration in ms after max retries exceeded. Default: 300000. */
  cooldownMs?: number;
}

export interface KeeperHandle {
  stop(): Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function keeperLog(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [KEEPER/${level}] ${msg}`);
}

/** Write a minimal MCP config JSON for Claude CLI to connect to the MCP HTTP server. */
function writeMcpConfig(path: string, port: number, secret: string | null): void {
  const serverConfig: Record<string, unknown> = {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
  };
  if (secret) serverConfig.headers = { Authorization: `Bearer ${secret}` };
  const config = { mcpServers: { "sensorium-mcp": serverConfig } };
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

/** Read-only peek at the last N messages from a thread's JSONL broker file for warm context. */
function readWarmContext(dataDir: string, threadId: number): string {
  const file = join(dataDir, "threads", `${threadId}.jsonl`);
  if (!existsSync(file)) return "";
  try {
    const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
    const recent = lines.slice(-WARM_CONTEXT_LINE_LIMIT);
    const texts: string[] = [];
    for (const line of recent) {
      try {
        const m = JSON.parse(line) as { message?: { text?: string; caption?: string } };
        const text = m.message?.text ?? m.message?.caption;
        if (text) texts.push(text.slice(0, WARM_CONTEXT_TEXT_LIMIT));
      } catch { /* skip corrupt lines */ }
    }
    if (!texts.length) return "";
    return (
      `[Warm context: last ${texts.length} messages from thread ${threadId}]\n` +
      texts.map((t) => `> ${t}`).join("\n") +
      "\n\n"
    );
  } catch {
    return "";
  }
}

/** Poll the MCP HTTP server until it responds or timeout elapses. */
async function waitForMcpReady(port: number, secret: string | null): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/api/status`;
  const headers: Record<string, string> = {};
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  const deadline = Date.now() + MCP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(3_000) });
      if (res.ok || res.status === 401) return true; // server is up (401 = auth required but responding)
    } catch { /* not ready yet */ }
    await new Promise<void>((r) => setTimeout(r, MCP_READY_POLL_INTERVAL_MS));
  }
  return false;
}

/** Check if any MCP session has polled wait_for_instructions within the liveness threshold. */
async function checkHttpLiveness(port: number, secret: string | null): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/api/sessions`;
  const headers: Record<string, string> = {};
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return false;
    const sessions = await res.json() as Array<{ lastWaitCallAt: number | null }>;
    const now = Date.now();
    return sessions.some(
      (s) => s.lastWaitCallAt !== null && now - s.lastWaitCallAt < LIVENESS_THRESHOLD_MS,
    );
  } catch {
    return false;
  }
}

// ─── Core keeper ──────────────────────────────────────────────────────────────

export async function startClaudeKeeper(config: KeeperConfig): Promise<KeeperHandle> {
  keeperLog("INFO", `Starting keeper for thread ${config.threadId} ('${config.sessionName}')`);
  writeMcpConfig(config.mcpConfigPath, config.mcpHttpPort, config.mcpHttpSecret);

  keeperLog("INFO", "Waiting for MCP server to be ready...");
  const ready = await waitForMcpReady(config.mcpHttpPort, config.mcpHttpSecret);
  if (!ready) keeperLog("WARN", "MCP server did not respond in time — spawning agent anyway.");
  else keeperLog("INFO", "MCP server ready.");

  let child: ChildProcess | null = null;
  let backoffMs = BASE_BACKOFF_MS;
  let stopped = false;
  let retryCount = 0;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  function scheduleRestart(): void {
    if (stopped) return;
    if (retryCount > maxRetries) {
      keeperLog("WARN", `Max retries (${maxRetries}) exceeded — cooling down for ${Math.round(cooldownMs / 1000)}s`);
      retryCount = 0;
      backoffMs = BASE_BACKOFF_MS;
      restartTimer = setTimeout(() => { restartTimer = null; spawnAgent(); }, cooldownMs);
      return;
    }
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    keeperLog("INFO", `Scheduling restart in ${delay}ms (attempt ${retryCount}/${maxRetries})...`);
    restartTimer = setTimeout(() => { restartTimer = null; spawnAgent(); }, delay);
  }

  function spawnAgent(): void {
    if (stopped) return;
    const warmContext = readWarmContext(config.dataDir, config.threadId);
    const prompt = `${warmContext}Start remote session with sensorium. Thread name = '${config.sessionName}'`;
    keeperLog("INFO", `Spawning ${config.claudeCmd} with ${warmContext ? "warm context" : "cold start"}`);

    try {
      // On Windows, claude is typically claude.cmd — shell:true is required to resolve it.
      const useShell = process.platform === "win32";
      const spawned = spawn(
        config.claudeCmd,
        ["--mcp-config", config.mcpConfigPath, "-p", prompt],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: useShell },
      );
      child = spawned;
      const spawnedAt = Date.now();

      spawned.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trimEnd();
        if (text) keeperLog("INFO", `[claude] ${text}`);
      });
      spawned.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trimEnd();
        if (text) keeperLog("WARN", `[claude:err] ${text}`);
      });
      spawned.on("error", (err: Error) => {
        keeperLog("ERROR", `Spawn error: ${err.message}`);
      });
      spawned.on("exit", (code, signal) => {
        if (child === spawned) child = null;
        if (stopped) return;
        const ranLongEnough = Date.now() - spawnedAt >= HEALTHY_UPTIME_MS;
        if (ranLongEnough) {
          // Healthy run — reset backoff and retry counter.
          backoffMs = BASE_BACKOFF_MS;
          retryCount = 0;
        } else {
          retryCount++;
        }
        keeperLog("WARN", `Claude exited (code=${code ?? "?"}, signal=${signal ?? "none"})`);
        scheduleRestart();
      });
    } catch (err) {
      keeperLog("ERROR", `Failed to spawn Claude: ${err}`);
      scheduleRestart();
    }
  }

  // Secondary liveness guard: force-restart if agent is alive but not polling
  livenessTimer = setInterval(async () => {
    if (stopped || child === null) return;
    const alive = await checkHttpLiveness(config.mcpHttpPort, config.mcpHttpSecret);
    if (!alive) {
      keeperLog("WARN", "No active polling session — force-restarting Claude agent.");
      child.kill();
      // exit handler will schedule the restart
    }
  }, LIVENESS_CHECK_INTERVAL_MS);

  spawnAgent();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (livenessTimer !== null) { clearInterval(livenessTimer); livenessTimer = null; }
      if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null; }
      if (child !== null) {
        keeperLog("INFO", "Stopping Claude agent...");
        child.kill();
        await new Promise<void>((r) => setTimeout(r, 2_000));
        child = null;
      }
      keeperLog("INFO", "Keeper stopped.");
    },
  };
}
