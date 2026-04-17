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

// --supervisor mode: launch the Go supervisor binary.
// Checked before heavy initialisation so the supervisor stays self-contained.
if (process.argv.includes("--supervisor")) {
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const binary = join(homedir(), ".remote-copilot-mcp", "bin",
    process.platform === "win32" ? "sensorium-supervisor.exe" : "sensorium-supervisor");
  try {
    execFileSync(binary, { stdio: "inherit", env: process.env });
  } catch (e: any) {
    if (e.status != null) process.exit(e.status);
    console.error(`Failed to start supervisor: ${e.message}`);
    console.error("Run 'npm run supervisor:install' first, or run Install-Sensorium.ps1 from the distribution root");
    process.exit(1);
  }
} else {

// Normal server startup ─────────────────────────────────────────────────────

const { config, setThreadDb } = await import("./config.js");
const { startDispatcher, setBrokerDb, setBrokerSentMessageRepository } = await import("./dispatcher.js");
const { initMemoryDb } = await import("./memory.js");
const { SqliteSentMessageRepository } = await import("./data/sent-message.repository.js");
const { TelegramClient } = await import("./telegram.js");
const { startHttpServer } = await import("./http-server.js");
const { startStdioServer } = await import("./stdio-server.js");
const { buildMcpServerFactory } = await import("./server/factory.js");
const { setTopicRegistryDb, sessionRepository } = await import("./sessions.js");
const { initVideoTempCleanup } = await import("./integrations/openai/video.js");
const { cleanupStalePidFiles, spawnKeepAliveThreads } = await import("./tools/thread-lifecycle.js");
const { log } = await import("./logger.js");
const { resolveTelegramTopicId, threadRepository } = await import("./data/memory/thread-registry.js");
const { BackgroundJobRunner } = await import("./services/background-runner.js");
const { ThreadLifecycleService } = await import("./services/thread-lifecycle.service.js");
const { clearReconnectSnapshot } = await import("./services/reconnect-snapshot.service.js");

// ---------------------------------------------------------------------------
// Shared singletons
// ---------------------------------------------------------------------------

const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = config;

const telegram = new TelegramClient(TELEGRAM_TOKEN);
const sentMessageRepository = new SqliteSentMessageRepository(getMemoryDb);

await startDispatcher(telegram, TELEGRAM_CHAT_ID);

// Memory database — initialized lazily on first use
let memoryDb: ReturnType<typeof initMemoryDb> | null = null;
function getMemoryDb() {
  if (!memoryDb) memoryDb = initMemoryDb();
  return memoryDb;
}

// Wire up sent-message persistence for per-thread reaction routing
telegram.setSentMessageRepository(sentMessageRepository);
setBrokerDb(getMemoryDb);
setBrokerSentMessageRepository(sentMessageRepository);

// Wire up topic ID resolver for logical-to-physical thread mapping
telegram.setTopicResolver((threadId) => resolveTelegramTopicId(getMemoryDb(), threadId));

// Wire up lazy DB access for SQLite-backed topic registry
setTopicRegistryDb(getMemoryDb);
// Wire up DB access for per-thread autonomous-mode resolution
setThreadDb(getMemoryDb);

const threadLifecycle = new ThreadLifecycleService(
  threadRepository,
  sessionRepository,
  telegram,
  log,
);

// Initialize video temp-file cleanup handlers (registers process exit hooks).
initVideoTempCleanup();

// Kill orphan agent processes from the previous server instance and spawn
// fresh processes for all keepAlive threads. This replaces the old PID-file
// restoration approach — no more PID orphans or ghost duplicates.
cleanupStalePidFiles();
const keepAlive = spawnKeepAliveThreads(threadLifecycle);
if (keepAlive.spawned > 0) log.info(`[startup] Spawned ${keepAlive.spawned} keepAlive thread(s).`);
if (keepAlive.errors.length > 0) log.warn(`[startup] keepAlive errors: ${keepAlive.errors.join("; ")}`);

// ---------------------------------------------------------------------------
// MCP Server factory (delegates to server/factory.ts)
// ---------------------------------------------------------------------------

const createMcpServer = buildMcpServerFactory(telegram, TELEGRAM_CHAT_ID, getMemoryDb, threadLifecycle);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

function closeMemoryDb(): void {
  if (memoryDb) {
    try { memoryDb.close(); } catch (_) { /* best-effort */ }
    memoryDb = null;
  }
}

if (process.env.MCP_HTTP_PORT) {
  startHttpServer(createMcpServer, getMemoryDb, closeMemoryDb);
} else {
  await startStdioServer(createMcpServer, closeMemoryDb);
}

const backgroundRunner = new BackgroundJobRunner({
  getMemoryDb,
  telegram,
  chatId: TELEGRAM_CHAT_ID,
  threadLifecycle,
  log,
});

// Start background jobs after the server is listening.
backgroundRunner.start();

// Auto-clear the reconnect snapshot 10 minutes after startup so stale
// snapshots from the previous process don't persist across multiple restarts.
setTimeout(() => clearReconnectSnapshot(), 10 * 60 * 1000);

}
