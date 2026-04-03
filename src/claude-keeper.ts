/**
 * Thread keeper — monitors keep-alive threads and restarts them
 * via the start_thread MCP tool when they stop running.
 *
 * No direct process spawning — delegates to start_thread which handles
 * all lifecycle concerns (PID tracking, registry updates, MCP config).
 */

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
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) h["Authorization"] = `Bearer ${secret}`;
  return h;
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
    const res = await fetch(`http://127.0.0.1:${port}/api/threads/${threadId}`, {
      headers: authHeaders(secret),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const data = await res.json() as { thread?: { status?: string } };
    const status = data.thread?.status;
    return status === "running" || status === "active";
  } catch {
    return false;
  }
}

async function callStartThread(config: KeeperConfig): Promise<boolean> {
  const { mcpHttpPort: port, mcpHttpSecret: secret, threadId, sessionName, client, workingDirectory } = config;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "start_thread",
      arguments: {
        name: sessionName,
        targetThreadId: threadId,
        agentType: client,
        workingDirectory: workingDirectory ?? process.cwd(),
      },
    },
    id: `keeper-${threadId}-${Date.now()}`,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: authHeaders(secret),
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      keeperLog("WARN", `start_thread HTTP ${res.status}: ${res.statusText}`);
      return false;
    }
    const result = await res.json() as { result?: { content?: Array<{ text?: string }> } };
    const text = result.result?.content?.[0]?.text ?? "";
    keeperLog("INFO", `start_thread response: ${text.slice(0, 200)}`);
    return !text.toLowerCase().includes("error");
  } catch (err) {
    keeperLog("ERROR", `start_thread call failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
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
