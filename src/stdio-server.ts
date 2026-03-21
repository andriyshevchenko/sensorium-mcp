/**
 * stdio transport bootstrap for the MCP server.
 *
 * Used when MCP_HTTP_PORT is not set — the default transport mode.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CreateMcpServerFn } from "./types.js";

export async function startStdioServer(
  createMcpServerFn: CreateMcpServerFn,
  closeMemoryDb: () => void,
): Promise<void> {
  const transport = new StdioServerTransport();
  const server = createMcpServerFn();
  await server.connect(transport);
  process.stderr.write("Remote Copilot MCP server running on stdio.\n");

  const stdioShutdown = () => {
    closeMemoryDb();
    process.exit(0);
  };
  process.on("SIGINT", stdioShutdown);
  process.on("SIGTERM", stdioShutdown);
  if (process.platform === "win32") {
    process.on("SIGBREAK", stdioShutdown);
  }
  process.on("exit", () => { closeMemoryDb(); });
}
