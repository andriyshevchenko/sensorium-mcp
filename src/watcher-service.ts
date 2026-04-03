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
import { cleanupExpiredWorkers } from "./tools/thread-lifecycle.js";
import { initMemoryDb } from "./data/memory/schema.js";

process.on("uncaughtException", (err) => {
  console.error(`[fatal] Uncaught exception: ${err.stack ?? err}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[fatal] Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
  process.exit(1);
});

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
let keeperPollerHandle: ReturnType<typeof setInterval> | null = null;
let sessionSweeperHandle: ReturnType<typeof setInterval> | null = null;
let workerCleanupHandle: ReturnType<typeof setInterval> | null = null;

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
    let resolvedThreadId = threadId;
    if (threadId) {
      try {
        const { resolveTelegramTopicId } = await import("./data/memory/thread-registry.js");
        const { initMemoryDb } = await import("./memory.js");
        resolvedThreadId = resolveTelegramTopicId(initMemoryDb(), threadId);
      } catch { /* use original threadId as fallback */ }
    }
    const body: Record<string, unknown> = { chat_id: TG_CHAT_ID, text, parse_mode: "HTML" };
    if (resolvedThreadId) body.message_thread_id = resolvedThreadId;
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

/** Single-shot HTTP liveness probe. Returns true if MCP server is responding. */
async function isMcpServerHealthy(): Promise<boolean> {
  const port = CONFIG.mcpHttpPort || 3847;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "OPTIONS", signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch { return false; }
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
 * Clean up PID files for dead processes.
 */
function readGhostThreads(): void {
  const pidsDir = join(CONFIG.dataDir, "pids");
  try {
    for (const file of readdirSync(pidsDir)) {
      if (!file.endsWith(".pid")) continue;
      const fullPath = join(pidsDir, file);
      const parsed = parsePidFile(fullPath);
      if (!parsed || !alive(parsed.pid)) {
        try { unlinkSync(fullPath); } catch { /* ignore */ }
      }
    }
  } catch { /* pids dir may not exist */ }
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
      // Use HTTP health probe instead of PID liveness — on Windows, shell: true
      // gives back the transient shell PID, not the real MCP server process.
      // The shell exits quickly, making alive(pid) return false even when the
      // server is healthy, causing a false-restart loop.
      if (!(await isMcpServerHealthy())) { log("WARN", "Server not running — restarting..."); await notifyOperator("\u26A0\uFE0F Watcher: server process not running — restarting..."); startMcpServer(); startTime = Date.now(); }
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
    // Clean up stale PID files before killing the server
    readGhostThreads();
    await stopMcpServer();
    clearNpxCache();
    setLocalVersion(remote);
    startMcpServer(); startTime = Date.now();
    await waitForServerReady();
    await killStale();
    removeMaintenanceFlag();
    // Keepers detect their agents died and restart them naturally
    // via scheduleRestart() and the applyKeeperSettings() poller.
    await notifyOperator(`\u2705 Watcher: update to v${remote} complete. Server ready.`);
    log("INFO", `Update to v${remote} complete.`);
  } finally {
    updateInProgress = false;
  }
}

// Claude CLI keeper -----------------------------------------------------------

const KEEPER_SETTINGS_POLL_MS = 2 * 60_000;

interface KeeperSettings {
  enabled: boolean;
  threadId: number;
  maxRetries: number;
  cooldownMs: number;
  client: string;
  sessionName: string;
}

/**
 * Read keeper settings from the thread_registry via the HTTP API.
 * Returns empty array if the server is not ready (keeper won't start until server is up).
 */
async function readAllKeeperSettings(): Promise<KeeperSettings[]> {
  const port = CONFIG.mcpHttpPort || 3847;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/threads/roots`, {
      headers: CONFIG.mcpHttpSecret ? { 'Authorization': `Bearer ${CONFIG.mcpHttpSecret}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { threads?: Record<string, unknown>[] };
    const roots = body.threads ?? [];
    return roots
      .filter((r) => r.keepAlive)
      .filter((r) => Number.isInteger(r.threadId) && (r.threadId as number) > 0)
      .map((r) => ({
        enabled: true,
        threadId: r.threadId as number,
        maxRetries: (typeof r.maxRetries === 'number' ? r.maxRetries : null) ?? 5,
        cooldownMs: (typeof r.cooldownMs === 'number' ? r.cooldownMs : null) ?? 300_000,
        client: typeof r.client === 'string' ? r.client : 'claude',
        sessionName: (typeof r.name === 'string' ? r.name : null) ?? `thread-${r.threadId}`,
      }));
  } catch {
    return [];
  }
}

function keeperSettingsChanged(a: KeeperSettings, b: KeeperSettings): boolean {
  return a.maxRetries !== b.maxRetries || a.cooldownMs !== b.cooldownMs || a.client !== b.client;
}

let applyingSettings = false;

async function applyKeeperSettings(): Promise<void> {
  if (applyingSettings) return;
  applyingSettings = true;
  try {
  if (CONFIG.mcpHttpPort <= 0) return;
  const allSettings = await readAllKeeperSettings();
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
      try {
        const handle = await startClaudeKeeper({
          threadId: settings.threadId,
          sessionName: settings.sessionName,
          client: settings.client,
          mcpHttpPort: CONFIG.mcpHttpPort,
          mcpHttpSecret: CONFIG.mcpHttpSecret,
          maxRetries: settings.maxRetries,
          cooldownMs: settings.cooldownMs,
        });
        keepers.set(settings.threadId, { handle, settings });
      } catch (err) {
        log("ERROR", `Failed to start keeper for thread ${settings.threadId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  } finally { applyingSettings = false; }
}

function startKeeperPoller(): void {
  keeperPollerHandle = setInterval(() => {
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
  const srv = new Server({ name: "sensorium-watcher", version: "1.0.0" }, { capabilities: { tools: {}, logging: {} } });
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "await_server_ready",
    description: "Blocks until sensorium finishes updating (maintenance.flag removed) or 120s timeout. Safe to call multiple times — returns immediately if no update in progress.",
    inputSchema: { type: "object" as const, properties: {
      threadId: { type: "number", description: "Telegram thread ID for reconnecting via start_session." },
    } },
  }] }));
  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "await_server_ready")
      return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    const tid = (req.params.arguments?.threadId as number | undefined) ?? 0;
    const lbl = tid ? `threadId=${tid}` : `threadId=<your thread>`;

    if (!flagExists()) {
      return { content: [{ type: "text", text: `Server ready. Call start_session with ${lbl}.` }] };
    }

    // Non-blocking: return immediately with retry instruction
    return { content: [{ type: "text", text: `Update in progress. Use Desktop Commander to run: Start-Sleep -Seconds 30 — then call await_server_ready again with ${lbl}. Repeat until ready.` }] };
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
  sessionSweeperHandle = setInterval(() => {
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
  // Disable Node.js HTTP server timeouts — await_server_ready can block
  // up to 600 s on a single SSE response.  The defaults (requestTimeout=300 s,
  // headersTimeout=60 s) would destroy the socket mid-wait, silently
  // dropping the tool result that eventually flows through the SSE stream.
  httpSrv.requestTimeout = 0;
  httpSrv.headersTimeout = 0;
  httpSrv.timeout = 0;
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
  // Periodic worker cleanup — every 5 minutes, clean expired workers that outlived their TTL
  workerCleanupHandle = setInterval(() => {
    const chatId = process.env.TELEGRAM_CHAT_ID || "";
    if (!chatId) return;
    void (async () => {
      try {
        const db = initMemoryDb();
        const token = process.env.TELEGRAM_TOKEN || "";
        const { resolveTelegramTopicId } = await import("./data/memory/thread-registry.js");
        const telegram = {
          async deleteForumTopic(cId: string, threadId: number): Promise<void> {
            if (!token) return;
            const topicId = resolveTelegramTopicId(db, threadId);
            await fetch(`https://api.telegram.org/bot${token}/deleteForumTopic`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: cId, message_thread_id: topicId }),
              signal: AbortSignal.timeout(10_000),
            });
          },
        };
        const result = await cleanupExpiredWorkers(db, telegram, chatId);
        if (result.cleaned > 0) log("INFO", `[worker-cleanup] Cleaned ${result.cleaned} expired worker threads`);
      } catch (err) {
        log("WARN", `[worker-cleanup] ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, 5 * 60 * 1000);

  const shutdown = async () => {
    if (keeperPollerHandle) clearInterval(keeperPollerHandle);
    if (sessionSweeperHandle) clearInterval(sessionSweeperHandle);
    if (workerCleanupHandle) clearInterval(workerCleanupHandle);
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