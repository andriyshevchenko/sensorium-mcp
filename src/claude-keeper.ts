/**
 * Thread keeper — monitors keep-alive threads and restarts them
 * via the start_thread MCP tool when they stop running.
 *
 * No direct process spawning — delegates to start_thread which handles
 * all lifecycle concerns (PID tracking, registry updates, MCP config).
 */

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const HEALTH_CHECK_INTERVAL_MS = 2 * 60_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_COOLDOWN_MS = 300_000;
const MCP_READY_POLL_INTERVAL_MS = 3_000;
const MCP_READY_TIMEOUT_MS = 120_000;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface KeeperConfig {
  threadId: number;
  sessionName: string;
  client: string;
  mcpHttpPort: number;
  mcpHttpSecret: string | null;
  workingDirectory?: string;
  maxRetries?: number;
  cooldownMs?: number;
}

export interface KeeperHandle {
  stop(): Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function keeperLog(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [KEEPER/${level}] ${msg}`);
}

function authHeaders(secret: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (secret) h["Authorization"] = `Bearer ${secret}`;
  return h;
}

/**
 * Parse a fetch Response that may be JSON or SSE (text/event-stream).
 * The MCP Streamable HTTP transport returns SSE when the Accept header
 * includes text/event-stream. Each SSE "data:" line contains a JSON-RPC
 * message. We extract the last data line as the result.
 */
async function parseJsonOrSse(res: Response): Promise<Record<string, unknown>> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    // Extract all "data:" lines and parse the last one (the final result)
    const dataLines = text.split("\n")
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim());
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try { return JSON.parse(dataLines[i]) as Record<string, unknown>; }
      catch { /* try previous line */ }
    }
    return {};
  }
  return await res.json() as Record<string, unknown>;
}

async function waitForMcpReady(port: number, secret: string | null): Promise<boolean> {
  const deadline = Date.now() + MCP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/threads/roots`, {
        headers: authHeaders(secret),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return true;
    } catch { /* server not ready */ }
    await new Promise(r => setTimeout(r, MCP_READY_POLL_INTERVAL_MS));
  }
  return false;
}

async function isThreadRunning(port: number, secret: string | null, threadId: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/threads/${threadId}/running`, {
      headers: authHeaders(secret),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const data = await res.json() as { running?: boolean };
    return data.running === true;
  } catch {
    return false;
  }
}

async function openMcpSession(port: number, secret: string | null): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: authHeaders(secret),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `keeper-init-${Date.now()}`,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "thread-keeper",
            version: "1.0.0",
          },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      keeperLog("WARN", `initialize HTTP ${res.status}: ${res.statusText}`);
      return null;
    }
    // Consume the body (may be SSE or JSON) to avoid connection stalls
    await res.text();
    const sessionId = res.headers.get("mcp-session-id");
    if (!sessionId) {
      keeperLog("WARN", "initialize succeeded but did not return an MCP session ID");
      return null;
    }

    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        ...authHeaders(secret),
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
      signal: AbortSignal.timeout(30_000),
    });

    return sessionId;
  } catch (err) {
    keeperLog("ERROR", `initialize failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function closeMcpSession(port: number, secret: string | null, sessionId: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "DELETE",
      headers: {
        ...authHeaders(secret),
        "mcp-session-id": sessionId,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort cleanup.
  }
}

async function callStartThread(config: KeeperConfig): Promise<boolean> {
  const { mcpHttpPort: port, mcpHttpSecret: secret, threadId, sessionName, client, workingDirectory } = config;
  const sessionId = await openMcpSession(port, secret);
  if (!sessionId) return false;

  try {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "start_thread",
        arguments: {
          name: sessionName,
          targetThreadId: threadId,
          agentType: client,
          mode: "resume",
          workingDirectory: workingDirectory ?? process.cwd(),
        },
      },
      id: `keeper-${threadId}-${Date.now()}`,
    });

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        ...authHeaders(secret),
        "mcp-session-id": sessionId,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      keeperLog("WARN", `start_thread HTTP ${res.status}: ${res.statusText}`);
      return false;
    }
    const result = await parseJsonOrSse(res) as { result?: { content?: Array<{ text?: string }> } };
    const text = result?.result?.content?.[0]?.text ?? "";
    keeperLog("INFO", `start_thread response: ${text.slice(0, 200)}`);
    return !text.toLowerCase().includes("error");
  } catch (err) {
    keeperLog("ERROR", `start_thread call failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    await closeMcpSession(port, secret, sessionId);
  }
}

// ─── Core keeper ──────────────────────────────────────────────────────────────

export async function startClaudeKeeper(config: KeeperConfig): Promise<KeeperHandle> {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  keeperLog("INFO", `Starting keeper for thread ${config.threadId} ('${config.sessionName}') [client=${config.client}]`);

  let stopped = false;
  let retryCount = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  keeperLog("INFO", "Waiting for MCP server to be ready...");
  const ready = await waitForMcpReady(config.mcpHttpPort, config.mcpHttpSecret);
  if (!ready) keeperLog("WARN", "MCP server did not respond in time — attempting start_thread anyway.");
  else keeperLog("INFO", "MCP server ready.");

  async function checkAndStart(): Promise<void> {
    if (stopped) return;

    const running = await isThreadRunning(config.mcpHttpPort, config.mcpHttpSecret, config.threadId);
    if (running) {
      scheduleCheck();
      return;
    }

    if (retryCount >= maxRetries) {
      keeperLog("WARN", `Max retries (${maxRetries}) exceeded — cooling down for ${Math.round(cooldownMs / 1000)}s`);
      retryCount = 0;
      timer = setTimeout(() => void checkAndStart(), cooldownMs);
      return;
    }

    retryCount++;
    keeperLog("INFO", `Thread ${config.threadId} not running — calling start_thread (attempt ${retryCount}/${maxRetries})`);

    const ok = await callStartThread(config);
    if (ok) {
      retryCount = 0;
      scheduleCheck();
    } else {
      const delay = Math.min(BASE_BACKOFF_MS * 2 ** retryCount, MAX_BACKOFF_MS);
      keeperLog("INFO", `Scheduling retry in ${delay}ms`);
      timer = setTimeout(() => void checkAndStart(), delay);
    }
  }

  function scheduleCheck(): void {
    if (stopped) return;
    timer = setTimeout(() => void checkAndStart(), HEALTH_CHECK_INTERVAL_MS);
  }

  void checkAndStart();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
