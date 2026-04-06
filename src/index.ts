#!/usr/bin/env node
/**
 * Remote Copilot MCP Server — entrypoint.
 *
 * Bootstraps shared singletons (Telegram client, dispatcher, memory DB)
 * and selects the transport mode (HTTP or stdio).  All per-session server
 * creation and tool dispatch logic lives in ./server/factory.ts.
 */

process.on("uncaughtException", (err) => {
  console.error(`[fatal] Uncaught exception: ${err.stack ?? err}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[fatal] Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
  process.exit(1);
});

// --watcher mode: update watcher + standby MCP server (replaces PowerShell script).
// Checked before heavy initialisation so the watcher stays self-contained.
if (process.argv.includes("--watcher")) {
  const { startWatcherService } = await import("./watcher-service.js");
  await startWatcherService();
} else {

// Normal server startup ─────────────────────────────────────────────────────

const { config } = await import("./config.js");
const { startDispatcher, setBrokerDb } = await import("./dispatcher.js");
const { initMemoryDb } = await import("./memory.js");
const { TelegramClient } = await import("./telegram.js");
const { startHttpServer } = await import("./http-server.js");
const { startStdioServer } = await import("./stdio-server.js");
const { buildMcpServerFactory } = await import("./server/factory.js");
const { setTopicRegistryDb, lookupTopicRegistry } = await import("./sessions.js");
const { initVideoTempCleanup } = await import("./integrations/openai/video.js");
const { cleanupStalePidFiles, spawnKeepAliveThreads } = await import("./tools/thread-lifecycle.js");
const { log } = await import("./logger.js");
const { rotateAllDailySessions } = await import("./daily-session.js");
const { resolveTelegramTopicId } = await import("./data/memory/thread-registry.js");

// ---------------------------------------------------------------------------
// Shared singletons
// ---------------------------------------------------------------------------

const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = config;

const telegram = new TelegramClient(TELEGRAM_TOKEN);

await startDispatcher(telegram, TELEGRAM_CHAT_ID);

// Memory database — initialized lazily on first use
let memoryDb: ReturnType<typeof initMemoryDb> | null = null;
function getMemoryDb() {
  if (!memoryDb) memoryDb = initMemoryDb();
  return memoryDb;
}

// Wire up lazy DB access for per-thread reaction routing
telegram.setMessageDb(getMemoryDb);
setBrokerDb(getMemoryDb);

// Wire up topic ID resolver for logical-to-physical thread mapping
telegram.setTopicResolver((threadId) => resolveTelegramTopicId(getMemoryDb(), threadId));

// Wire up lazy DB access for SQLite-backed topic registry
setTopicRegistryDb(getMemoryDb);

// Ensure SecureVault topic exists in the registry (resolved dynamically, not hardcoded).
// If no entry exists yet, the operator should register it via the topic-registry tools.
const secureVaultThreadId = lookupTopicRegistry(TELEGRAM_CHAT_ID, "SecureVault");
if (secureVaultThreadId === undefined) {
  console.warn("[init] SecureVault topic not found in registry — register it via topic-registry tools or start_session.");
}

// Initialize video temp-file cleanup handlers (registers process exit hooks).
initVideoTempCleanup();

// Kill orphan agent processes from the previous server instance and spawn
// fresh processes for all keepAlive threads. This replaces the old PID-file
// restoration approach — no more PID orphans or ghost duplicates.
cleanupStalePidFiles();
const keepAlive = spawnKeepAliveThreads();
if (keepAlive.spawned > 0) log.info(`[startup] Spawned ${keepAlive.spawned} keepAlive thread(s).`);
if (keepAlive.errors.length > 0) log.warn(`[startup] keepAlive errors: ${keepAlive.errors.join("; ")}`);

// ---------------------------------------------------------------------------
// MCP Server factory (delegates to server/factory.ts)
// ---------------------------------------------------------------------------

const createMcpServer = buildMcpServerFactory(telegram, TELEGRAM_CHAT_ID, getMemoryDb);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

function closeMemoryDb(): void {
  if (memoryDb) {
    try { memoryDb.close(); } catch (_) { /* best-effort */ }
    memoryDb = null;
  }
}

// ---------------------------------------------------------------------------
// Daily session rotation timer (runs in the MCP server process which has
// all env vars — OpenAI, Telegram, etc.)
// ---------------------------------------------------------------------------

const DAILY_ROTATION_HOUR = 4;

function startDailyRotationTimer(): void {
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() !== DAILY_ROTATION_HOUR || now.getMinutes() >= 5) return;
    try {
      log.info("Starting daily session rotation...");
      const results = await rotateAllDailySessions();
      for (const r of results) {
        if (r.error) {
          log.error(`Daily rotation failed for root ${r.rootThreadId}: ${r.error}`);
        } else {
          log.info(`Daily rotation complete for root ${r.rootThreadId}`);
        }
      }
    } catch (err) {
      log.error(`Daily rotation error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 5 * 60_000);
}

const httpPort = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : undefined;
if (httpPort) {
  startHttpServer(createMcpServer, getMemoryDb, closeMemoryDb);
} else {
  await startStdioServer(createMcpServer, closeMemoryDb);
}

// Start daily rotation timer after server is listening
startDailyRotationTimer();

}
