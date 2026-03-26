/** Watcher Service — Node.js replacement for update-watcher.ps1. Run: npx sensorium-mcp --watcher */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, unlinkSync } from "node:fs";
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
};
let startTime = Date.now();
let managedChild: ChildProcess | null = null;
let httpSrv: HttpServer | null = null;

// Helpers ---------------------------------------------------------------------
function log(level: string, msg: unknown): void {
  console.log(`[${new Date().toISOString().replace("T", " ").slice(0, 19)}] [${level}] ${String(msg)}`);
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
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

// Version & flag management ---------------------------------------------------
function getLocalVersion(): string | null { return safeRead(P.ver); }
function setLocalVersion(v: string): void { ensureDir(); writeFileSync(P.ver, v, "utf-8"); }
function writeMaintenanceFlag(v: string): void {
  ensureDir();
  writeFileSync(P.flag, JSON.stringify({ version: v, timestamp: new Date().toISOString() }), "utf-8");
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
function writePid(pid: number): void { ensureDir(); writeFileSync(P.pid, String(pid), "utf-8"); }
function rmPid(): void { try { if (existsSync(P.pid)) unlinkSync(P.pid); } catch { /**/ } }

function startMcpServer(): ChildProcess | null {
  const [cmd, ...args] = CONFIG.mcpStartCommand.split(" ");
  log("INFO", `Starting MCP server: ${CONFIG.mcpStartCommand}`);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: true, windowsHide: true });
    child.unref();
    if (child.pid) { writePid(child.pid); log("INFO", `MCP server PID ${child.pid}`); }
    managedChild = child;
    return child;
  } catch (err) { log("ERROR", `Failed to start MCP server: ${err}`); return null; }
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
  try { process.kill(pid, "SIGTERM"); await sleep(2000); if (alive(pid)) process.kill(pid, "SIGKILL"); } catch { /**/ }
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
    for (const e of readdirSync(base))
      if (existsSync(join(base, e, "node_modules", "sensorium-mcp")))
        rmSync(join(base, e), { recursive: true, force: true });
  } catch (err) { log("WARN", `Cache clear error: ${err}`); }
}

// Stale process cleanup -------------------------------------------------------
function killStale(): void {
  const pid = readPid();
  if (!pid) return;
  if (!alive(pid)) { rmPid(); return; }
  try {
    if (!existsSync(P.ver) || !existsSync(P.pid)) return;
    if (statSync(P.pid).mtimeMs < statSync(P.ver).mtimeMs - 60_000) {
      log("WARN", `Killing stale PID ${pid}`);
      try { process.kill(pid, "SIGKILL"); } catch { /**/ }
      rmPid();
    }
  } catch { /**/ }
}

// Registry check --------------------------------------------------------------
async function getRemoteVersion(): Promise<string | null> {
  try {
    const r = await fetch("https://registry.npmjs.org/sensorium-mcp/latest");
    return ((await r.json()) as { version?: string }).version ?? null;
  } catch (err) { log("ERROR", `Registry check failed: ${err}`); return null; }
}

// Update orchestration --------------------------------------------------------
async function checkAndUpdate(): Promise<void> {
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
  killStale();
  removeMaintenanceFlag();
  log("INFO", `Update to v${remote} complete.`);
}

// Main loop -------------------------------------------------------------------
async function runLoop(): Promise<void> {
  log("INFO", `Watcher starting in ${CONFIG.mode} mode.`);
  ensureDir();
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
      try { killStale(); await checkAndUpdate(); } catch (err) { log("ERROR", err); removeMaintenanceFlag(); }
      await sleep(CONFIG.pollIntervalSeconds * 1000);
    }
  }
}

// MCP server (await_server_ready) — in-process HTTP ----------------------------
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
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function startHttpMcp(port: number): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();
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
            onsessioninitialized: (s) => { transports.set(s, t); },
          });
          t.onclose = () => { const s = t.sessionId; if (s) transports.delete(s); };
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
    } catch {
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null })); }
    }
  });
  httpSrv.listen(port, "127.0.0.1", () => log("INFO", `Watcher MCP on http://127.0.0.1:${port}/mcp`));
}

// Signal handling & entry point -----------------------------------------------
export async function startWatcherService(): Promise<void> {
  const shutdown = () => {
    log("INFO", "Shutting down watcher...");
    if (managedChild?.pid && alive(managedChild.pid)) try { process.kill(managedChild.pid, "SIGTERM"); } catch { /**/ }
    httpSrv?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  startHttpMcp(CONFIG.httpPort);
  await runLoop();
}
