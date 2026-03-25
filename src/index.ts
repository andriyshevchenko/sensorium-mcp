#!/usr/bin/env node
/**
 * Remote Copilot MCP Server — entrypoint.
 *
 * Bootstraps shared singletons (Telegram client, dispatcher, memory DB)
 * and selects the transport mode (HTTP or stdio).  All per-session server
 * creation and tool dispatch logic lives in ./server/factory.ts.
 */

import { config } from "./config.js";
import { startDispatcher, setBrokerDb } from "./dispatcher.js";
import { initMemoryDb } from "./memory.js";
import { TelegramClient } from "./telegram.js";
import { startHttpServer } from "./http-server.js";
import { startStdioServer } from "./stdio-server.js";
import { buildMcpServerFactory } from "./server/factory.js";
import { setTopicRegistryDb, lookupTopicRegistry } from "./sessions.js";
import { initVideoTempCleanup } from "./integrations/openai/video.js";

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
