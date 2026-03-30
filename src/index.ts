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
const { cleanupStalePidFiles } = await import("./tools/thread-lifecycle.js");

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

// Clean up stale PID files from ghost threads that were killed during a
// previous server update (taskkill /T kills the entire process tree).
// Without this, orphaned PID files cause get_threads_health to show dead
// threads as "dormant" when the PID is reused by an unrelated process.
cleanupStalePidFiles();

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

const httpPort = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : undefined;
if (httpPort) {
  startHttpServer(createMcpServer, getMemoryDb, closeMemoryDb);
} else {
  await startStdioServer(createMcpServer, closeMemoryDb);
}

}
