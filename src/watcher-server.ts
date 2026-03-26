/**
 * Watcher MCP server — lightweight standby server that agents call
 * during sensorium updates instead of sleeping 600 seconds.
 *
 * Run via: npx sensorium-mcp --watcher                          (stdio)
 *          npx sensorium-mcp --watcher --watcher-port 3848      (HTTP)
 *
 * Registers a single tool `await_server_ready` that polls for the
 * removal of ~/.remote-copilot-mcp/maintenance.flag.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const MAINTENANCE_FLAG = join(homedir(), ".remote-copilot-mcp", "maintenance.flag");
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 600_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Create a watcher Server instance with the await_server_ready tool. */
function createWatcherMcpServer(): Server {
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

  return server;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/** Parse --watcher-port from process.argv. Returns undefined if not set. */
function parseWatcherPort(): number | undefined {
  const idx = process.argv.indexOf("--watcher-port");
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  const port = parseInt(process.argv[idx + 1], 10);
  return Number.isNaN(port) ? undefined : port;
}

// ---------------------------------------------------------------------------
// HTTP transport helpers
// ---------------------------------------------------------------------------

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

/** Start the watcher in HTTP mode on the given port. */
async function startWatcherHttp(port: number): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (req.method === "POST") {
        const body = await parseBody(req);

        // Existing session
        const existing = sessionId ? transports.get(sessionId) : undefined;
        if (existing) { await existing.handleRequest(req, res, body); return; }

        // New session — initialize handshake
        if (isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => { transports.set(sid, transport); },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) transports.delete(sid);
          };

          const server = createWatcherMcpServer();
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null }));
        return;
      }

      if (req.method === "GET") {
        const t = sessionId ? transports.get(sessionId) : undefined;
        if (!t) { res.writeHead(400, { "Content-Type": "text/plain" }); res.end("Invalid session"); return; }
        await t.handleRequest(req, res);
        return;
      }

      if (req.method === "DELETE") {
        const t = sessionId ? transports.get(sessionId) : undefined;
        if (t) { await t.handleRequest(req, res); }
        else { res.writeHead(400, { "Content-Type": "text/plain" }); res.end("Invalid session"); }
        return;
      }

      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  });

  httpServer.listen(port, "127.0.0.1", () => {
    console.error(`Watcher MCP server running on http://127.0.0.1:${port}/mcp`);
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function startWatcherServer(): Promise<void> {
  const port = parseWatcherPort();

  if (port) {
    await startWatcherHttp(port);
  } else {
    const server = createWatcherMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
