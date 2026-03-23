/**
 * stdio transport bootstrap for the MCP server.
 *
 * Used when MCP_HTTP_PORT is not set — the default transport mode.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { log } from "./logger.js";
import {
  registerDashboardSession,
  markDashboardSessionDisconnected,
} from "./sessions.js";
import type { CreateMcpServerFn } from "./types.js";

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

  const stdioShutdown = () => {
    markDashboardSessionDisconnected(stdioSessionId);
    closeMemoryDb();
    process.exit(0);
  };
  process.on("SIGINT", stdioShutdown);
  process.on("SIGTERM", stdioShutdown);
  if (process.platform === "win32") {
    process.on("SIGBREAK", stdioShutdown);
  }
  process.on("exit", () => {
    markDashboardSessionDisconnected(stdioSessionId);
    closeMemoryDb();
  });
}
