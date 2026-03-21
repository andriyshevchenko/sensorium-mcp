/**
 * HTTP/SSE transport bootstrap for the MCP server.
 *
 * Handles:
 *   - HTTP server creation with all routes (POST/GET/DELETE /mcp)
 *   - CORS handling
 *   - Dashboard routing
 *   - Auth checking (MCP_HTTP_SECRET)
 *   - Session management (transports map, activity tracking)
 *   - Session reaper interval
 *   - Graceful shutdown (SIGINT/SIGTERM/SIGBREAK)
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "better-sqlite3";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { config } from "./config.js";
import { log } from "./logger.js";
import { handleDashboardRequest, type DashboardContext } from "./dashboard.js";
import { threadSessionRegistry } from "./sessions.js";
import type { CreateMcpServerFn } from "./types.js";

export function startHttpServer(
  createMcpServerFn: CreateMcpServerFn,
  getMemoryDb: () => Database,
  closeMemoryDb: () => void,
): void {
  const httpPort = parseInt(process.env.MCP_HTTP_PORT!, 10);
  const httpBind = process.env.MCP_HTTP_BIND ?? "127.0.0.1";

  const transports = new Map<string, StreamableHTTPServerTransport>();
  /** Tracks the last time each HTTP session received any request (epoch ms). */
  const sessionLastActivity = new Map<string, number>();
  /** Tracks session lifecycle status for dashboard visibility. */
  const sessionStatus = new Map<string, "active" | "disconnected">();

  const MCP_HTTP_SECRET = process.env.MCP_HTTP_SECRET;
  const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
  const serverStartTime = Date.now();

  async function parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      req.on("data", (c: Buffer) => {
        totalSize += c.length;
        if (totalSize > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error("Request body too large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
      req.on("error", reject);
    });
  }

  const httpServer = createServer(async (req: IncomingMessage, res) => {
   try {
    // CORS for local dev (restrict to localhost)
    const origin = req.headers.origin ?? "";
    const allowedOrigin = origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/) ? origin : "";
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Dashboard routes (served before MCP auth) ─────────────────────
    const dashCtx: DashboardContext = {
      getDb: getMemoryDb,
      getActiveSessions: () => {
        const sessions: Array<{ threadId: number; mcpSessionId: string; lastActivity: number; transportType: string; status: "active" | "disconnected" }> = [];
        for (const [sid, status] of sessionStatus) {
          // Find which thread this session belongs to
          let threadId = 0;
          for (const [tid, entries] of threadSessionRegistry) {
            if (entries.some(e => e.mcpSessionId === sid)) { threadId = tid; break; }
          }
          sessions.push({
            threadId,
            mcpSessionId: sid,
            lastActivity: sessionLastActivity.get(sid) ?? 0,
            transportType: "http",
            status,
          });
        }
        return sessions;
      },
      serverStartTime,
    };
    // Dashboard HTML pages: no auth needed (SPA handles auth in browser)
    // Dashboard API routes: auth handled by handleDashboardRequest internally
    const dashUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const isDashboardPage = dashUrl.pathname === "/" || dashUrl.pathname === "/dashboard";
    const isDashboardApi = dashUrl.pathname.startsWith("/api/");
    if (isDashboardPage || isDashboardApi) {
      const handled = handleDashboardRequest(req, res, dashCtx, MCP_HTTP_SECRET);
      if (handled) return;
    }

    // Auth check — if MCP_HTTP_SECRET is set, require Bearer token.
    // Use constant-time comparison to prevent timing attacks.
    if (MCP_HTTP_SECRET) {
      const auth = req.headers.authorization ?? "";
      const expected = `Bearer ${MCP_HTTP_SECRET}`;
      const authBuf = Buffer.from(auth);
      const expectedBuf = Buffer.from(expected);
      if (authBuf.length !== expectedBuf.length || !timingSafeEqual(authBuf, expectedBuf)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await parseBody(req);
      } catch {
        res.writeHead(413, { "Content-Type": "text/plain" });
        res.end("Request body too large or malformed");
        return;
      }

      // Existing session
      if (sessionId && transports.has(sessionId)) {
        sessionLastActivity.set(sessionId, Date.now());
        sessionStatus.set(sessionId, "active");
        await transports.get(sessionId)!.handleRequest(req, res, body);
        return;
      }

      // New session — must be initialize
      if (!sessionId && isInitializeRequest(body)) {
        let capturedSid: string | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            capturedSid = sid;
            transports.set(sid, transport);
            sessionLastActivity.set(sid, Date.now());
            sessionStatus.set(sid, "active");
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            transports.delete(sid);
            // Keep in sessionLastActivity & sessionStatus for dashboard visibility
            sessionStatus.set(sid, "disconnected");
          }
        };

        // Create a fresh Server per HTTP session — a single Server can only
        // connect to one transport, so concurrent clients each need their own.
        const sessionServer = createMcpServerFn(
          () => capturedSid,
          () => { try { transport.close(); } catch (_) { /* best-effort */ } },
        );
        await sessionServer.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID or not an initialize request" },
        id: null,
      }));
      return;
    }

    if (req.method === "GET") {
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      sessionLastActivity.set(sessionId, Date.now());
      // Detect SSE stream close — mark session as disconnected
      const sseSid = sessionId;
      res.on("close", () => {
        if (sessionStatus.has(sseSid)) {
          sessionStatus.set(sseSid, "disconnected");
        }
      });
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    if (req.method === "DELETE") {
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      sessionLastActivity.set(sessionId, Date.now());
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
   } catch (err) {
    log.error(`[http] Unhandled error: ${typeof err === 'object' && err !== null && 'message' in err ? (err as Error).message : String(err)}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
   }
  });

  httpServer.listen(httpPort, httpBind, () => {
    log.info(`Remote Copilot MCP server running on http://${httpBind}:${httpPort}/mcp`);
  });

  // ── TTL sweeper — mark idle active sessions as disconnected every 5 min ──
  const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
  const ttlSweeperInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, status] of sessionStatus) {
      if (status === "active" && !transports.has(sid)) {
        // Transport already gone but status wasn't updated — fix it
        sessionStatus.set(sid, "disconnected");
      } else if (status === "active") {
        const lastActive = sessionLastActivity.get(sid) ?? 0;
        if (now - lastActive > SESSION_IDLE_TTL_MS) {
          log.info(`[session-ttl] Marking session ${sid.slice(0, 8)} as disconnected (idle ${Math.round((now - lastActive) / 60000)}m)`);
          sessionStatus.set(sid, "disconnected");
        }
      }
    }
  }, 5 * 60 * 1000);

  // ── Session reaper — close abandoned SSE sessions every 10 minutes ──────
  const STALE_SESSION_MS = 2 * config.WAIT_TIMEOUT_MINUTES * 60 * 1000;
  const sessionReaperInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, transport] of transports) {
      const lastActive = sessionLastActivity.get(sid) ?? 0;
      if (now - lastActive > STALE_SESSION_MS) {
        log.info(`[session-reaper] Closing stale session ${sid} (idle ${Math.round((now - lastActive) / 60000)}m)`);
        try { transport.close(); } catch (_) { /* best-effort */ }
        transports.delete(sid);
        sessionLastActivity.delete(sid);
        sessionStatus.delete(sid);
      }
    }
    // Also purge long-disconnected sessions from tracking maps
    for (const [sid, status] of sessionStatus) {
      if (status === "disconnected" && !transports.has(sid)) {
        const lastActive = sessionLastActivity.get(sid) ?? 0;
        if (now - lastActive > STALE_SESSION_MS) {
          sessionLastActivity.delete(sid);
          sessionStatus.delete(sid);
        }
      }
    }
  }, 10 * 60 * 1000);

  // Simple shutdown — close transports, DB, and exit.
  const shutdown = () => {
    clearInterval(ttlSweeperInterval);
    clearInterval(sessionReaperInterval);
    for (const [sid, t] of transports) {
      try { t.close(); } catch (_) { /* best-effort */ }
      transports.delete(sid);
    }
    httpServer.close();
    closeMemoryDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.platform === "win32") {
    process.on("SIGBREAK", shutdown);
  }
  process.on("exit", () => { closeMemoryDb(); });
}
