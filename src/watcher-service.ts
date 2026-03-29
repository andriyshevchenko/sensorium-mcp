/** Watcher Service — Node.js replacement for update-watcher.ps1. Run: npx sensorium-mcp --watcher */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startClaudeKeeper, type KeeperHandle } from "./claude-keeper.js";

// Configuration ---------------------------------------------------------------
const CONFIG = {
  mode: process.env.WATCHER_MODE || "development",
  pollAtHour: parseInt(process.env.WATCHER_POLL_HOUR || "4", 10),
  pollIntervalSeconds: parseInt(process.env.WATCHER_POLL_INTERVAL || "60", 10),
  gracePeriodSeconds: parseInt(process.env.WATCHER_GRACE_PERIOD || ((process.env.WATCHER_MODE || "development") === "development" ? "10" : "300"), 10),
  idleThresholdSeconds: 300, maxIdleWaitSeconds: 300,
  minUptimeSeconds: 600,
  httpPort: parseInt(process.env.WATCHER_PORT || "3848", 10),
  mcpStartCommand: process.env.MCP_START_COMMAND || "securevault run npx -y sensorium-mcp@latest --profile SENSORIUM",
  dataDir: join(homedir(), ".remote-copilot-mcp"),
  // Always-on CLI keeper
  alwaysOnThreadId: parseInt(process.env.ALWAYS_ON_THREAD_ID || "0", 10),
  alwaysOnSessionName: process.env.ALWAYS_ON_SESSION_NAME || "always-on-keepalive",
  claudeCmd: process.env.CLAUDE_CLI_CMD || "claude",
  copilotCmd: process.env.COPILOT_CLI_CMD || "copilot",
  mcpHttpPort: parseInt(process.env.MCP_HTTP_PORT || "0", 10),
  mcpHttpSecret: process.env.MCP_HTTP_SECRET || null,
};
const P = {
  flag: join(CONFIG.dataDir, "maintenance.flag"), ver: join(CONFIG.dataDir, "current-version.txt"),
  activity: join(CONFIG.dataDir, "last-activity.txt"), pid: join(CONFIG.dataDir, "server.pid"),
  lock: join(CONFIG.dataDir, "watcher.lock"),
};
let startTime = Date.now();
let managedChild: ChildProcess | null = null;
let httpSrv: HttpServer | null = null;
let updateInProgress = false;
const keepers = new Map<number, { handle: KeeperHandle; settings: KeeperSettings }>();

// Helpers ---------------------------------------------------------------------
function log(level: "INFO" | "WARN" | "ERROR", msg: unknown): void {
  const text = msg instanceof Error ? `${msg.message}\n${msg.stack}` : String(msg);
  console.log(`[${new Date().toISOString().replace("T", " ").slice(0, 19)}] [${level}] ${text}`);
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function ensureDir(): void { if (!existsSync(CONFIG.dataDir)) mkdirSync(CONFIG.dataDir, { recursive: true }); }
function uptimeS(): number { return (Date.now() - startTime) / 1000; }

// ── Lightweight Telegram notification (no dependency on telegram.ts) ─────────

const TG_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

/**
 * Send a Telegram message from the watcher process.
 * Uses raw fetch against the Bot API — does not depend on the main server
 * or any agent connections. If token/chatId are missing, silently no-ops.
 */
async function notifyOperator(text: string, threadId?: number): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const body: Record<string, unknown> = { chat_id: TG_CHAT_ID, text, parse_mode: "HTML" };
    if (threadId) body.message_thread_id = threadId;
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log("WARN", `Telegram notify failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function msUntilHour(h: number): number {
  const now = new Date(), t = new Date(now);
  t.setHours(h, 0, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime() - now.getTime();
}
function safeRead(p: string): string | null {
  try { return existsSync(p) ? readFileSync(p, "utf-8").trim() || null : null; } catch { return null; }
}
function alive(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf-8", timeout: 5000 });
      return out.includes(String(pid));
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killPid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    // /F /T = force-kill entire process tree (parent + children).
    // Without /F, Windows refuses to kill a parent whose children are still running.
    try { execSync(`taskkill /F /T /PID ${pid}`, { timeout: 10000 }); } catch { /**/ }
    await sleep(3000);
    if (alive(pid)) {
      try { execSync(`taskkill /F /T /PID ${pid}`, { timeout: 10000 }); } catch { /**/ }
    }
  } else {
    try { process.kill(pid, "SIGTERM"); } catch { /**/ }
    await sleep(2000);
    if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /**/ } }
  }
}

function atomicWrite(path: string, data: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, path);
}

// Version & flag management ---------------------------------------------------
function getLocalVersion(): string | null { return safeRead(P.ver); }
function setLocalVersion(v: string): void { ensureDir(); atomicWrite(P.ver, v); }
function writeMaintenanceFlag(v: string): void {
  ensureDir();
  atomicWrite(P.flag, JSON.stringify({ version: v, timestamp: new Date().toISOString() }));
  log("INFO", `Maintenance flag written for v${v}`);
}
function removeMaintenanceFlag(): void {
  try { if (existsSync(P.flag)) { unlinkSync(P.flag); log("INFO", "Maintenance flag removed."); } } catch { /**/ }
}
function flagExists(): boolean { return existsSync(P.flag); }

// Activity heartbeat ----------------------------------------------------------
function activityAgeSec(): number | null {
  const raw = safeRead(P.activity);
  if (!raw) return null;
  const e = parseInt(raw, 10);
  return Number.isNaN(e) ? null : (Date.now() - e) / 1000;
}

// Process management (PID file) -----------------------------------------------
function readPid(): number | null {
  const raw = safeRead(P.pid);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}
function writePid(pid: number): void { ensureDir(); atomicWrite(P.pid, String(pid)); }
function rmPid(): void { try { if (existsSync(P.pid)) unlinkSync(P.pid); } catch { /**/ } }

function startMcpServer(): void {
  const parts = CONFIG.mcpStartCommand.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  log("INFO", `Starting MCP server: ${CONFIG.mcpStartCommand}`);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, shell: true });
    child.on("error", (err) => log("ERROR", `MCP server spawn error: ${err.message}`));
    if (child.pid) {
      writePid(child.pid);
      managedChild = child;
      child.unref();
      log("INFO", `MCP server started (PID ${child.pid})`);
    }
  } catch (err) { log("ERROR", `Failed to start MCP server: ${err}`); }
}

async function stopMcpServer(): Promise<void> {
  const pid = readPid();
  if (!pid || !alive(pid)) { rmPid(); return; }
  log("INFO", `Waiting for PID ${pid} to idle...`);
  let waited = 0;
  while (waited < CONFIG.maxIdleWaitSeconds) {
    const age = activityAgeSec();
    if (age === null || age >= CONFIG.idleThresholdSeconds) { log("INFO", "Server idle."); break; }
    log("INFO", `Active (${Math.round(age)}s ago) — waiting...`);
    await sleep(5000); waited += 5;
  }
  if (waited >= CONFIG.maxIdleWaitSeconds) log("WARN", "Max idle wait exceeded — force-killing.");
  await killPid(pid);
  rmPid(); managedChild = null;
  log("INFO", `PID ${pid} stopped.`);
}

// Server readiness check ------------------------------------------------------
/** Poll the MCP HTTP server until it responds or 60s timeout. */
async function waitForServerReady(): Promise<void> {
  const port = CONFIG.mcpHttpPort || 3847;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "OPTIONS", signal: AbortSignal.timeout(2000) });
      if (res.status < 500) { log("INFO", "MCP server ready (HTTP responding)."); return; }
    } catch { /* server not up yet */ }
    await sleep(2000);
  }
  log("WARN", "MCP server did not respond within 60s — proceeding anyway.");
}

// npx cache clearing ----------------------------------------------------------
function clearNpxCache(): void {
  const base = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "npm-cache", "_npx")
    : join(homedir(), ".npm", "_npx");
  if (!existsSync(base)) return;
  log("INFO", "Clearing sensorium-mcp from npx cache...");
  try {
    for (const e of readdirSync(base)) {
      const pkgDir = join(base, e, "node_modules", "sensorium-mcp");
      if (existsSync(pkgDir)) rmSync(pkgDir, { recursive: true, force: true });
    }
  } catch (err) { log("WARN", `Cache clear error: ${err}`); }
}

// Stale process cleanup -------------------------------------------------------
async function killStale(): Promise<void> {
  const pid = readPid();
  if (!pid) return;
  if (!alive(pid)) { rmPid(); return; }
  try {
    if (!existsSync(P.ver) || !existsSync(P.pid)) return;
    if (statSync(P.pid).mtimeMs < statSync(P.ver).mtimeMs - 60_000) {
      log("WARN", `Killing stale PID ${pid}`);
      await killPid(pid);
      rmPid();
    }
  } catch { /**/ }
}

// Registry check --------------------------------------------------------------
const REGISTRY_URL = "https://registry.npmjs.org/sensorium-mcp/latest";

// Ghost thread re-spawn helpers -----------------------------------------------

interface GhostThreadInfo {
  threadId: number;
  name: string;
}

/**
 * Parse a single PID file and return pid + name, or null if unparseable.
 */
function parsePidFile(filePath: string): { pid: number; name?: string } | null {
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    try {
      const meta = JSON.parse(raw) as { pid: number; name?: string };
      return Number.isFinite(meta.pid) ? meta : null;
    } catch {
      const pid = Number(raw);
      return Number.isFinite(pid) ? { pid } : null;
    }
  } catch {
    return null;
  }
}

/**
 * Read active ghost thread info from PID files before killing the MCP server.
 * Only returns threads whose processes are currently alive.
 */
function readGhostThreads(): GhostThreadInfo[] {
  const pidsDir = join(CONFIG.dataDir, "pids");
  // Read session store for name lookups (reverse map: threadId → name)
  const sessionStorePath = join(homedir(), ".remote-copilot-mcp-sessions.json");
  const threadNames = new Map<number, string>();
  try {
    const sessions = JSON.parse(readFileSync(sessionStorePath, "utf-8")) as Record<string, Record<string, number>>;
    for (const chatTopics of Object.values(sessions)) {
      for (const [name, tid] of Object.entries(chatTopics)) {
        threadNames.set(tid, name);
      }
    }
  } catch { /* no sessions file */ }

  const threads: GhostThreadInfo[] = [];
  try {
    for (const file of readdirSync(pidsDir)) {
      if (!file.endsWith(".pid")) continue;
      const threadId = Number(file.replace(".pid", ""));
      if (!Number.isFinite(threadId)) continue;
      const parsed = parsePidFile(join(pidsDir, file));
      if (!parsed || !alive(parsed.pid)) continue;
      threads.push({
        threadId,
        name: parsed.name ?? threadNames.get(threadId) ?? `thread-${threadId}`,
      });
    }
  } catch { /* pids dir may not exist */ }
  return threads;
}

/**
 * Re-spawn ghost threads after a server update.
 * Each thread gets a fresh Claude CLI pointed at the updated MCP server,
 * with sensorium-watcher included in the config for future update resilience.
 */
async function respawnGhostThreads(threads: GhostThreadInfo[]): Promise<void> {
  if (threads.length === 0) return;

  // Resolve base MCP config (same candidates as thread-lifecycle.ts)
  const candidates = [
    process.env.CLAUDE_MCP_CONFIG,
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".claude", "mcp_config.json"),
    join(homedir(), ".claude", ".mcp.json"),
  ].filter(Boolean) as string[];
  const baseConfigPath = candidates.find((p) => existsSync(p));
  if (!baseConfigPath) {
    log("WARN", "Cannot re-spawn ghost threads: no MCP config found");
    return;
  }

  // Generate a merged config that includes sensorium-watcher
  const mergedConfigPath = join(CONFIG.dataDir, "ghost-respawn-mcp-config.json");
  try {
    const raw = readFileSync(baseConfigPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    if (!servers["sensorium-watcher"]) {
      servers["sensorium-watcher"] = {
        type: "http",
        url: `http://127.0.0.1:${CONFIG.httpPort}/mcp`,
      };
      config.mcpServers = servers;
    }
    writeFileSync(mergedConfigPath, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    log("WARN", `Failed to generate merged MCP config for re-spawn: ${err}`);
    return;
  }

  const claudeCmd = CONFIG.claudeCmd;
  const useShell = process.platform === "win32";
  const logsDir = join(CONFIG.dataDir, "logs");
  const pidsDir = join(CONFIG.dataDir, "pids");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(pidsDir, { recursive: true });

  for (const thread of threads) {
    // Skip threads managed by a keeper — the keeper handles its own restart
    if (keepers.has(thread.threadId)) continue;

    log("INFO", `Re-spawning ghost thread ${thread.threadId} ("${thread.name}")`);

    const dateStr = new Date().toISOString().slice(0, 10);
    const safeName = thread.name.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
    const logFile = join(logsDir, `${safeName}_${thread.threadId}_${dateStr}.json`);
    const prompt = `Start remote session with sensorium. Thread name = '${thread.name}'`;

    try {
      const logFd = openSync(logFile, "a");
      const child = spawn(claudeCmd, [
        "--verbose",
        "--dangerously-skip-permissions",
        "--mcp-config", mergedConfigPath,
        "-p", prompt,
        "--output-format", "stream-json",
        "--include-partial-messages",
      ], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        shell: useShell,
        windowsHide: true,
      });
      closeSync(logFd);

      if (child.pid) {
        const pidFile = join(pidsDir, `${thread.threadId}.pid`);
        writeFileSync(pidFile, JSON.stringify({ pid: child.pid, name: thread.name, startedAt: Date.now() }), "utf-8");
        child.unref();
        log("INFO", `Re-spawned ghost thread ${thread.threadId} (PID ${child.pid})`);
      }
    } catch (err) {
      log("ERROR", `Failed to re-spawn ghost thread ${thread.threadId}: ${err}`);
    }
  }
}
async function getRemoteVersion(): Promise<string | null> {
  try {
    const r = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) { log("WARN", `Registry returned HTTP ${r.status}`); return null; }
    return ((await r.json()) as { version?: string }).version ?? null;
  } catch (err) { log("ERROR", `Registry check failed: ${err}`); return null; }
}

// Update orchestration --------------------------------------------------------
async function checkAndUpdate(): Promise<void> {
  if (updateInProgress) { log("INFO", "Update already in progress, skipping"); return; }
  updateInProgress = true;
  try {
    if (uptimeS() > 120) {
      const pid = readPid();
      if (!pid || !alive(pid)) { log("WARN", "Server not running — restarting..."); await notifyOperator("\u26A0\uFE0F Watcher: server process not running — restarting..."); startMcpServer(); startTime = Date.now(); }
    }
    const remote = await getRemoteVersion();
    if (!remote) return;
    const local = getLocalVersion();
    if (!local) { setLocalVersion(remote); return; }
    if (remote === local) { log("INFO", `Up to date: v${local}`); return; }
    if (uptimeS() < CONFIG.minUptimeSeconds) { log("INFO", "Deferring update — too early."); return; }
    log("INFO", `Update: v${local} → v${remote}`);
    await notifyOperator(`\u2699\uFE0F Watcher: updating sensorium v${local} \u2192 v${remote}. Grace period ${CONFIG.gracePeriodSeconds}s...`);
    writeMaintenanceFlag(remote);
    log("INFO", `Grace period ${CONFIG.gracePeriodSeconds}s...`);
    await sleep(CONFIG.gracePeriodSeconds * 1000);
    // Save active ghost thread info BEFORE killing the server.
    // taskkill /F /T kills the entire process tree including ghost threads,
    // so we need to re-spawn them after the update.
    const ghostThreads = readGhostThreads();
    if (ghostThreads.length > 0) {
      const desc = ghostThreads.map(t => String(t.threadId) + '("' + t.name + '")').join(", ");
      log("INFO", `Saved ${ghostThreads.length} ghost thread(s) for re-spawn after update: ${desc}`);
    }
    await stopMcpServer();
    clearNpxCache();
    setLocalVersion(remote);
    startMcpServer(); startTime = Date.now();
    await waitForServerReady();
    await killStale();
    removeMaintenanceFlag();
    // Re-spawn ghost threads that were killed during the update
    if (ghostThreads.length > 0) {
      log("INFO", "Re-spawning ghost threads...");
      await respawnGhostThreads(ghostThreads);
    }
    await notifyOperator(`\u2705 Watcher: update to v${remote} complete. Server ready.` + (ghostThreads.length > 0 ? ` Re-spawned ${ghostThreads.length} ghost thread(s).` : ""));
    log("INFO", `Update to v${remote} complete.`);
  } finally {
    updateInProgress = false;
  }
}

// Claude CLI keeper -----------------------------------------------------------

const SETTINGS_JSON_PATH = join(CONFIG.dataDir, "settings.json");
const KEEPER_SETTINGS_POLL_MS = 2 * 60_000;

interface KeeperSettings {
  enabled: boolean;
  threadId: number;
  maxRetries: number;
  cooldownMs: number;
  client: "claude" | "copilot";
  sessionName: string;
}

function readAllKeeperSettings(): KeeperSettings[] {
  const raw = safeRead(SETTINGS_JSON_PATH);
  const s: Record<string, unknown> = raw
    ? (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; } })()
    : {};

  const results: KeeperSettings[] = [];

  // Global keep-alive (backward-compatible)
  const globalThreadId = typeof s.keepAliveThreadId === "number" && s.keepAliveThreadId > 0
    ? s.keepAliveThreadId
    : CONFIG.alwaysOnThreadId;
  const globalEnabled = typeof s.keepAliveEnabled === "boolean"
    ? s.keepAliveEnabled
    : CONFIG.alwaysOnThreadId > 0;
  const globalMaxRetries = typeof s.keepAliveMaxRetries === "number" && s.keepAliveMaxRetries > 0
    ? s.keepAliveMaxRetries : 5;
  const globalCooldownMs = typeof s.keepAliveCooldownMs === "number" && s.keepAliveCooldownMs >= 1000
    ? s.keepAliveCooldownMs : 300_000;
  const globalClient = s.keepAliveClient === "copilot" ? "copilot" as const : "claude" as const;

  if (globalEnabled && globalThreadId > 0) {
    results.push({
      enabled: true,
      threadId: globalThreadId,
      maxRetries: globalMaxRetries,
      cooldownMs: globalCooldownMs,
      client: globalClient,
      sessionName: CONFIG.alwaysOnSessionName,
    });
  }

  // Per-thread overrides
  const threadMap = s.threadKeepAlive as Record<string, unknown> | undefined;
  if (threadMap && typeof threadMap === "object") {
    for (const [idStr, val] of Object.entries(threadMap)) {
      if (!val || typeof val !== "object") continue;
      const e = val as Record<string, unknown>;
      const tid = Number(idStr);
      if (!tid || tid <= 0) continue;
      // Skip if same as global (already handled)
      if (tid === globalThreadId && globalEnabled) continue;
      if (typeof e.enabled === "boolean" && e.enabled) {
        results.push({
          enabled: true,
          threadId: tid,
          maxRetries: typeof e.maxRetries === "number" && e.maxRetries > 0 ? e.maxRetries : globalMaxRetries,
          cooldownMs: typeof e.cooldownMs === "number" && e.cooldownMs >= 1000 ? e.cooldownMs : globalCooldownMs,
          client: e.client === "copilot" ? "copilot" : e.client === "claude" ? "claude" : globalClient,
          sessionName: `thread-${tid}`,
        });
      }
    }
  }

  return results;
}

function keeperSettingsChanged(a: KeeperSettings, b: KeeperSettings): boolean {
  return a.maxRetries !== b.maxRetries || a.cooldownMs !== b.cooldownMs || a.client !== b.client;
}

async function applyKeeperSettings(): Promise<void> {
  if (CONFIG.mcpHttpPort <= 0) return;
  const allSettings = readAllKeeperSettings();
  const desiredThreadIds = new Set(allSettings.map(s => s.threadId));

  // Stop keepers for threads that are no longer configured
  for (const [tid, entry] of keepers) {
    if (!desiredThreadIds.has(tid)) {
      log("INFO", `Keep-alive disabled for thread ${tid} — stopping keeper.`);
      await entry.handle.stop();
      keepers.delete(tid);
    }
  }

  // Start or restart keepers
  for (const settings of allSettings) {
    const existing = keepers.get(settings.threadId);

    // Restart if settings changed
    if (existing && keeperSettingsChanged(existing.settings, settings)) {
      log("INFO", `Keep-alive settings changed for thread ${settings.threadId} — restarting keeper.`);
      await existing.handle.stop();
      keepers.delete(settings.threadId);
    }

    // Start if not running
    if (!keepers.has(settings.threadId)) {
      const handle = await startClaudeKeeper({
        threadId: settings.threadId,
        sessionName: settings.sessionName,
        client: settings.client,
        claudeCmd: CONFIG.claudeCmd,
        copilotCmd: CONFIG.copilotCmd,
        mcpConfigPath: join(CONFIG.dataDir, `mcp-config-${settings.threadId}.json`),
        mcpHttpPort: CONFIG.mcpHttpPort,
        mcpHttpSecret: CONFIG.mcpHttpSecret,
        dataDir: CONFIG.dataDir,
        maxRetries: settings.maxRetries,
        cooldownMs: settings.cooldownMs,
      });
      keepers.set(settings.threadId, { handle, settings });
    }
  }
}

function startKeeperPoller(): void {
  setInterval(() => {
    void applyKeeperSettings().catch((err) => log("ERROR", `Keeper settings poll failed: ${err}`));
  }, KEEPER_SETTINGS_POLL_MS);
}

// Main loop -------------------------------------------------------------------
async function runLoop(): Promise<void> {
  log("INFO", `Watcher starting in ${CONFIG.mode} mode.`);
  ensureDir();
  // Clear stale maintenance flag left by a previous crash
  if (flagExists()) {
    const stalePid = readPid();
    const local = getLocalVersion();
    if (local && stalePid && alive(stalePid)) {
      log("WARN", "Stale maintenance.flag found — server already running at current version. Removing.");
      removeMaintenanceFlag();
    }
  }
  const pid = readPid();
  if (!pid || !alive(pid)) startMcpServer();
  void applyKeeperSettings().catch((err) => log("ERROR", `Keeper failed to start: ${err}`));
  startKeeperPoller();
  if (CONFIG.mode === "production") {
    while (true) {
      const ms = msUntilHour(CONFIG.pollAtHour);
      log("INFO", `Next check in ${Math.round(ms / 60_000)}m (at ${CONFIG.pollAtHour}:00).`);
      await sleep(ms);
      try { await checkAndUpdate(); } catch (err) { log("ERROR", err); removeMaintenanceFlag(); }
    }
  } else {
    while (true) {
      try { await killStale(); await checkAndUpdate(); } catch (err) { log("ERROR", err); removeMaintenanceFlag(); }
      await sleep(CONFIG.pollIntervalSeconds * 1000);
    }
  }
}

// MCP server (await_server_ready) — in-process HTTP ---------------------------
function createWatcherMcp(): Server {
  const srv = new Server({ name: "sensorium-watcher", version: "1.0.0" }, { capabilities: { tools: {} } });
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "await_server_ready",
    description: "Blocks until sensorium finishes updating (maintenance.flag removed) or 600s timeout.",
    inputSchema: { type: "object" as const, properties: {
      threadId: { type: "number", description: "Telegram thread ID for reconnecting via start_session." },
    } },
  }] }));
  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "await_server_ready")
      return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    const tid = (req.params.arguments?.threadId as number | undefined) ?? 0;
    const lbl = tid ? `threadId=${tid}` : `threadId=<your thread>`;
    const deadline = Date.now() + 600_000;
    while (flagExists() && Date.now() < deadline) await sleep(2_000);
    if (!flagExists()) return { content: [{ type: "text", text: `Server ready. **Wait 15 seconds** for the MCP client to reconnect (use Desktop Commander: Start-Sleep -Seconds 15), then call start_session with ${lbl}.` }] };
    return { content: [{ type: "text", text: `Timed out. Try start_session with ${lbl} anyway.` }] };
  });
  return srv;
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  const MAX_BODY = 1_048_576; // 1 MB
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(new Error("Request body exceeds 1 MB limit")); return; }
      chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function startHttpMcp(port: number): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionCreated = new Map<string, number>();
  // Session TTL: 24 hours.  Ghost threads establish their watcher session at
  // startup but may not need await_server_ready for hours.  The old 600 s
  // timeout caused sessions to expire before the first update arrived,
  // making await_server_ready fail with "Bad Request".
  const SESSION_TTL_MS = 86_400_000;
  setInterval(() => {
    for (const [sid, ts] of sessionCreated) {
      if (Date.now() - ts > SESSION_TTL_MS) {
        transports.get(sid)?.close?.();
        transports.delete(sid);
        sessionCreated.delete(sid);
      }
    }
  }, 60_000);
  httpSrv = createServer(async (req, res) => {
    // CORS: restrict to localhost origins (match http-server.ts pattern)
    const origin = req.headers.origin ?? "";
    const allowedOrigin = origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/) ? origin : "";
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.url !== "/mcp") { res.writeHead(404); res.end("Not Found"); return; }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    try {
      if (req.method === "POST") {
        const body = await parseBody(req);
        const existing = sid ? transports.get(sid) : undefined;
        if (existing) { await existing.handleRequest(req, res, body); return; }
        // If the client sent a session ID we don't recognise (expired /
        // watcher restarted), return 404 per the MCP Streamable HTTP spec
        // so the client re-initialises instead of giving up.
        if (sid && !existing && !isInitializeRequest(body)) {
          log("WARN", `Unknown session ${sid} — returning 404 to trigger re-init`);
          res.writeHead(404); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found — please re-initialize" }, id: null }));
          return;
        }
        if (isInitializeRequest(body)) {
          const t = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (s) => { transports.set(s, t); sessionCreated.set(s, Date.now()); },
          });
          t.onclose = () => { const s = t.sessionId; if (s) { transports.delete(s); sessionCreated.delete(s); } };
          await (createWatcherMcp()).connect(t);
          await t.handleRequest(req, res, body); return;
        }
        res.writeHead(400); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: expected initialize" }, id: null }));
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        const t = sid ? transports.get(sid) : undefined;
        if (t) { await t.handleRequest(req, res); } else { res.writeHead(404); res.end("Session not found"); }
        return;
      }
      res.writeHead(405); res.end("Method Not Allowed");
    } catch (err) {
      log("ERROR", `HTTP handler error: ${err}`);
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null })); }
    }
  });
  httpSrv.listen(port, "127.0.0.1", () => log("INFO", `Watcher MCP on http://127.0.0.1:${port}/mcp`));
}

// Lockfile — prevent two watcher instances --------------------------------------
let lockFd: number | null = null;
function acquireLock(): boolean {
  try {
    ensureDir();
    lockFd = openSync(P.lock, "wx");
    writeFileSync(lockFd, String(process.pid));
    return true;
  } catch {
    // Check if the existing lock holder is still alive
    const raw = safeRead(P.lock);
    if (raw) {
      const pid = parseInt(raw, 10);
      if (!Number.isNaN(pid) && alive(pid)) {
        log("ERROR", `Another watcher is already running (PID ${pid}). Exiting.`);
        return false;
      }
    }
    // Stale lock — reclaim
    try { unlinkSync(P.lock); } catch { /**/ }
    try {
      lockFd = openSync(P.lock, "wx");
      writeFileSync(lockFd, String(process.pid));
      log("WARN", "Reclaimed stale watcher lockfile.");
      return true;
    } catch {
      log("ERROR", "Failed to acquire watcher lockfile.");
      return false;
    }
  }
}
function releaseLock(): void {
  if (lockFd !== null) { try { closeSync(lockFd); } catch { /**/ } lockFd = null; }
  try { if (existsSync(P.lock)) unlinkSync(P.lock); } catch { /**/ }
}

// Signal handling & entry point -----------------------------------------------
export async function startWatcherService(): Promise<void> {
  if (!acquireLock()) { process.exit(1); return; }
  const shutdown = async () => {
    log("INFO", "Shutting down watcher...");
    for (const [, entry] of keepers) { await entry.handle.stop(); }
    keepers.clear();
    await stopMcpServer();
    httpSrv?.close();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  startHttpMcp(CONFIG.httpPort);
  await runLoop();
}