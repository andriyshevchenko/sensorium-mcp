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

// Configuration ---------------------------------------------------------------
const CONFIG = {
  mode: process.env.WATCHER_MODE || "development",
  pollAtHour: parseInt(process.env.WATCHER_POLL_HOUR || "4", 10),
  pollIntervalSeconds: parseInt(process.env.WATCHER_POLL_INTERVAL || "60", 10),
  gracePeriodSeconds: 300, idleThresholdSeconds: 300, maxIdleWaitSeconds: 300,
  minUptimeSeconds: 600,
  httpPort: parseInt(process.env.WATCHER_PORT || "3848", 10),
  mcpStartCommand: process.env.MCP_START_COMMAND || "securevault run npx -y sensorium-mcp@latest --profile SENSORIUM",
  dataDir: join(homedir(), ".remote-copilot-mcp"),
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

// Helpers ---------------------------------------------------------------------
function log(level: "INFO" | "WARN" | "ERROR", msg: unknown): void {
  const text = msg instanceof Error ? `${msg.message}\n${msg.stack}` : String(msg);
  console.log(`[${new Date().toISOString().replace("T", " ").slice(0, 19)}] [${level}] ${text}`);
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function ensureDir(): void { if (!existsSync(CONFIG.dataDir)) mkdirSync(CONFIG.dataDir, { recursive: true }); }
function uptimeS(): number { return (Date.now() - startTime) / 1000; }
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
    try { execSync(`taskkill /PID ${pid} /T`, { timeout: 5000 }); } catch { /**/ }
    await sleep(2000);
    if (alive(pid)) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000 }); } catch { /**/ }
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
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
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
      if (!pid || !alive(pid)) { log("WARN", "Server not running — restarting..."); startMcpServer(); startTime = Date.now(); }
    }
    const remote = await getRemoteVersion();
    if (!remote) return;
    const local = getLocalVersion();
    if (!local) { setLocalVersion(remote); return; }
    if (remote === local) { log("INFO", `Up to date: v${local}`); return; }
    if (uptimeS() < CONFIG.minUptimeSeconds) { log("INFO", "Deferring update — too early."); return; }
    log("INFO", `Update: v${local} → v${remote}`);
    writeMaintenanceFlag(remote);
    log("INFO", `Grace period ${CONFIG.gracePeriodSeconds}s...`);
    await sleep(CONFIG.gracePeriodSeconds * 1000);
    await stopMcpServer();
    clearNpxCache();
    setLocalVersion(remote);
    startMcpServer(); startTime = Date.now();
    await sleep(10_000);
    await killStale();
    removeMaintenanceFlag();
    log("INFO", `Update to v${remote} complete.`);
  } finally {
    updateInProgress = false;
  }
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
    if (!flagExists()) return { content: [{ type: "text", text: `Server ready. Call start_session with ${lbl}.` }] };
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
  setInterval(() => {
    for (const [sid, ts] of sessionCreated) {
      if (Date.now() - ts > 600_000) {
        transports.get(sid)?.close?.();
        transports.delete(sid);
        sessionCreated.delete(sid);
      }
    }
  }, 60_000);
  httpSrv = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.url !== "/mcp") { res.writeHead(404); res.end("Not Found"); return; }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    try {
      if (req.method === "POST") {
        const body = await parseBody(req);
        const existing = sid ? transports.get(sid) : undefined;
        if (existing) { await existing.handleRequest(req, res, body); return; }
        if (isInitializeRequest(body)) {
          const t = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (s) => { transports.set(s, t); sessionCreated.set(s, Date.now()); },
          });
          t.onclose = () => { const s = t.sessionId; if (s) { transports.delete(s); sessionCreated.delete(s); } };
          await (createWatcherMcp()).connect(t);
          await t.handleRequest(req, res, body); return;
        }
        res.writeHead(400); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null }));
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        const t = sid ? transports.get(sid) : undefined;
        if (t) { await t.handleRequest(req, res); } else { res.writeHead(400); res.end("Invalid session"); }
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