/**
 * stdio transport bootstrap for the MCP server.
 *
 * Used when MCP_HTTP_PORT is not set — the default transport mode.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { log } from "./logger.js";
import {
  getActiveThreadIds,
  registerDashboardSession,
  markDashboardSessionDisconnected,
} from "./sessions.js";
import { writeReconnectSnapshot } from "./services/reconnect-snapshot.service.js";
import type { CreateMcpServerFn } from "./types.js";

process.on("uncaughtException", (err) => {
  console.error(`[fatal] Uncaught exception: ${err.stack ?? err}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[fatal] Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
  process.exit(1);
});

export async function startStdioServer(
  createMcpServerFn: CreateMcpServerFn,
  closeMemoryDb: () => void,
): Promise<void> {
  const transport = new StdioServerTransport();
  const stdioSessionId = randomUUID();

  const server = createMcpServerFn(
    () => stdioSessionId,
    () => { try { transport.close?.(); } catch (_) { /* best-effort */ } },
  );
  await server.connect(transport);

  // Register the STDIO session so it appears on the dashboard
  registerDashboardSession(stdioSessionId, "stdio");

  log.info("Remote Copilot MCP server running on stdio.");

  let shuttingDown = false;
  const stdioShutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[shutdown] Graceful stdio shutdown (${reason})…`);

    // Snapshot active threads so the next server instance can lightweight-reconnect.
    const activeThreadIds = getActiveThreadIds();
    if (activeThreadIds.length > 0) {
      writeReconnectSnapshot(activeThreadIds);
    }
    // Tear down server and transport before closing resources.
    try { await server.close(); } catch (_) { /* best-effort */ }
    try { transport.close?.(); } catch (_) { /* best-effort */ }
    closeMemoryDb();
    markDashboardSessionDisconnected(stdioSessionId);
    process.exit(0);
  };
  process.on("SIGINT",  () => { void stdioShutdown("SIGINT"); });
  process.on("SIGTERM", () => { void stdioShutdown("SIGTERM"); });
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => { void stdioShutdown("SIGBREAK"); });
  }
  process.on("exit", () => {
    markDashboardSessionDisconnected(stdioSessionId);
    closeMemoryDb();
  });
}
