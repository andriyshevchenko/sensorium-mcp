/**
 * Watcher MCP server — lightweight standby server that agents call
 * during sensorium updates instead of sleeping 600 seconds.
 *
 * Run via: npx sensorium-mcp --watcher
 *
 * Registers a single tool `await_server_ready` that polls for the
 * removal of ~/.remote-copilot-mcp/maintenance.flag.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const MAINTENANCE_FLAG = join(homedir(), ".remote-copilot-mcp", "maintenance.flag");
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 600_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function startWatcherServer(): Promise<void> {
  const server = new Server(
    { name: "sensorium-watcher", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "await_server_ready",
        description:
          "Blocks until the sensorium server finishes updating (maintenance.flag removed) " +
          "or 600 s timeout. Returns a message telling the agent to reconnect.",
        inputSchema: {
          type: "object" as const,
          properties: {
            threadId: {
              type: "number",
              description: "Telegram thread ID to pass back when reconnecting via start_session.",
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "await_server_ready") {
      return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    }

    const threadId = (req.params.arguments?.threadId as number | undefined) ?? 0;
    const label = threadId ? `threadId=${threadId}` : `threadId=<your thread>`;

    try {
      const deadline = Date.now() + MAX_WAIT_MS;
      while (existsSync(MAINTENANCE_FLAG) && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
      }

      if (!existsSync(MAINTENANCE_FLAG)) {
        return {
          content: [{ type: "text", text: `Server ready. Call start_session with ${label} to reconnect.` }],
        };
      }

      return {
        content: [{ type: "text", text: `Update timed out. Try calling start_session with ${label} anyway.` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error while waiting: ${String(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
