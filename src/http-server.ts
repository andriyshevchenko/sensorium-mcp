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

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "better-sqlite3";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { config } from "./config.js";
import { log } from "./logger.js";
import { errorMessage } from "./utils.js";
import { handleDashboardRequest, type DashboardContext } from "./dashboard.js";
import type { ThreadLifecycleService } from "./services/thread-lifecycle.service.js";
import {
  consumeExpectedMcpSessionClose,
  expectMcpSessionClose,
  getThreadIdForMcpSession,
  registerDashboardSession,
  unregisterMcpSession,
  updateDashboardActivity,
  markDashboardSessionDisconnected,
  removeDashboardSession,
  getDashboardSessions,
  WAIT_LIVENESS_MS,
} from "./sessions.js";
import { getThread } from "./data/memory/thread-registry.js";
import { findAliveThread } from "./services/process.service.js";
import type { CreateMcpServerFn } from "./types.js";

class BodyParseError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413,
  ) {
    super(message);
  }
}

export function startHttpServer(
  createMcpServerFn: CreateMcpServerFn,
  getMemoryDb: () => Database,
  closeMemoryDb: () => void,
  threadLifecycle: ThreadLifecycleService,
): void {
  const rawPort = Number.parseInt(process.env.MCP_HTTP_PORT ?? "", 10);
  const httpPort = Number.isFinite(rawPort) ? rawPort : 3847;
  const httpBind = process.env.MCP_HTTP_BIND ?? "127.0.0.1";

  /** Consolidated per-session state. */
  interface SessionEntry {
    transport: StreamableHTTPServerTransport | null;
    server: Server | null;
    lastActivity: number;
    status: "active" | "disconnected";
    disconnectedAt?: number;
  }

  const sessions = new Map<string, SessionEntry>();

  const MCP_HTTP_SECRET = process.env.MCP_HTTP_SECRET;
  const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
  const serverStartTime = Date.now();

  async function closeSessionServer(entry: SessionEntry | undefined): Promise<void> {
    if (!entry?.server) return;
    const server = entry.server;
    entry.server = null;
    try {
      await server.close();
    } catch {
      // Best-effort cleanup during disconnect/shutdown paths.
    }
  }

  async function parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      req.on("data", (c: Buffer) => {
        totalSize += c.length;
        if (totalSize > MAX_BODY_SIZE) {
          req.destroy();
          reject(new BodyParseError("Request body too large", 413));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch {
          reject(new BodyParseError("Malformed JSON request body", 400));
        }
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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
        return getDashboardSessions();
      },
      serverStartTime,
      threadLifecycle,
    };
    // Dashboard HTML pages: no auth needed (SPA handles auth in browser)
    // Dashboard API routes: auth handled by handleDashboardRequest internally
    const dashUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const isDashboardPage = dashUrl.pathname === "/" || dashUrl.pathname === "/dashboard";
    const isDashboardApi = dashUrl.pathname.startsWith("/api/");
    if (isDashboardPage || isDashboardApi) {
      const handled = await handleDashboardRequest(req, res, dashCtx, MCP_HTTP_SECRET);
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

    // Ensure Accept header includes required MIME types for Streamable HTTP.
    // Internal callers (e.g. keeper) may omit it, causing a 406 from the SDK.
    // Must patch rawHeaders (used by @hono/node-server), not just headers.
    if (req.method === "POST" && !req.headers.accept?.includes("text/event-stream")) {
      const acceptValue = "application/json, text/event-stream";
      req.headers.accept = acceptValue;
      // rawHeaders is the source of truth for @hono/node-server's header conversion
      const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === "accept");
      if (idx >= 0) {
        req.rawHeaders[idx + 1] = acceptValue;
      } else {
        req.rawHeaders.push("Accept", acceptValue);
      }
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await parseBody(req);
      } catch (err) {
        const statusCode = err instanceof BodyParseError ? err.statusCode : 400;
        const message = err instanceof BodyParseError ? err.message : "Malformed request body";
        res.writeHead(statusCode, { "Content-Type": "text/plain" });
        res.end(message);
        return;
      }

      // Existing session
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing?.transport) {
        existing.lastActivity = Date.now();
        existing.status = "active";
        delete existing.disconnectedAt;
        updateDashboardActivity(sessionId!);
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      // New session OR session adoption after server restart.
      // Accept initialize requests regardless of whether the client sent a
      // (now stale) session ID.  This covers:
      //   - Brand-new clients (no sessionId header)
      //   - Clients reconnecting after a server restart whose SDK transport
      //     still carries the old session ID (e.g. Claude Code CLI)
      if (isInitializeRequest(body)) {
        // If the client sent a stale session ID, clean up any leftover
        // tracking state from the previous incarnation.
        if (sessionId) {
          log.info(`[http] Session adoption: stale session ${sessionId.slice(0, 8)}… re-initializing`);
          sessions.delete(sessionId);
          removeDashboardSession(sessionId);
        }

        let capturedSid: string | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            capturedSid = sid;
            sessions.set(sid, { transport, server: null, lastActivity: Date.now(), status: "active" });
            registerDashboardSession(sid, "http");
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          const expectedClose = sid ? consumeExpectedMcpSessionClose(sid) : false;
          if (sid) {
            const entry = sessions.get(sid);
            if (entry) {
              // Keep entry for dashboard visibility but clear transport
              entry.transport = null;
              entry.status = "disconnected";
              void closeSessionServer(entry);
              entry.disconnectedAt = Date.now();
            }
            markDashboardSessionDisconnected(sid);
            const threadId = getThreadIdForMcpSession(sid);
            unregisterMcpSession(sid);
            if (!expectedClose && threadId !== undefined) {
              const thread = getThread(getMemoryDb(), threadId);
              if (thread?.status === "active") {
                const alive = findAliveThread(threadId);
                if (alive) {
                  log.warn(`[session] Session closed for thread ${threadId} - killing process ${alive.pid} to force reconnect`);
                  try { process.kill(alive.pid, "SIGTERM"); } catch (_) { /* best-effort */ }
                }
              }
            }
          }
        };

        // Create a fresh Server per HTTP session — a single Server can only
        // connect to one transport, so concurrent clients each need their own.
        const sessionServer = createMcpServerFn(
          () => capturedSid,
          () => { try { transport.close(); } catch (_) { /* best-effort */ } },
        );
        await sessionServer.connect(transport);
        // Store server reference so it can be closed during shutdown
        if (capturedSid) {
          const entry = sessions.get(capturedSid);
          if (entry) entry.server = sessionServer;
        }
        await transport.handleRequest(req, res, body);
        return;
      }

      // Non-initialize request with an unknown/stale session ID.
      // Return 404 per MCP spec ("Session not found") so clients know
      // the session is gone and should re-initialize from scratch.
      if (sessionId) {
        log.warn(`[http] Unknown session ${sessionId.slice(0, 8)}… — returning 404 (session not found)`);
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        }));
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
      const getEntry = sessionId ? sessions.get(sessionId) : undefined;
      if (!getEntry?.transport) {
        if (sessionId) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }));
        } else {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing session ID");
        }
        return;
      }
      getEntry.lastActivity = Date.now();
      // Detect SSE stream close — mark session as disconnected
      const sseSid = sessionId!;
      res.on("close", () => {
        const sseEntry = sessions.get(sseSid);
        if (sseEntry) {
          sseEntry.status = "disconnected";
          if (sseEntry.disconnectedAt == null) {
            sseEntry.disconnectedAt = Date.now();
          }
          markDashboardSessionDisconnected(sseSid);
        }
      });
      await getEntry.transport.handleRequest(req, res);
      return;
    }

    if (req.method === "DELETE") {
      const delEntry = sessionId ? sessions.get(sessionId) : undefined;
      if (!delEntry?.transport) {
        if (sessionId) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }));
        } else {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing session ID");
        }
        return;
      }
      delEntry.lastActivity = Date.now();
      await delEntry.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
   } catch (err) {
    log.error(`[http] Unhandled error: ${errorMessage(err)}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
   }
  });

  // Use generous but bounded timeouts — voice transcription + analysis
  // can take several minutes, but infinite timeouts enable DoS.
  httpServer.requestTimeout = 30 * 60 * 1000; // 30 min
  httpServer.headersTimeout = 60 * 1000;       // 60 s for headers

  httpServer.listen(httpPort, httpBind, () => {
    log.info(`Remote Copilot MCP server running on http://${httpBind}:${httpPort}/mcp`);
  });

  // ── Unified session sweep — runs every 60 s ────────────────────────────
  // Combines the former TTL sweeper, Session GC, and Session reaper into a
  // single pass so there is only one interval to manage.
  const SESSION_IDLE_TTL_MS = config.WAIT_TIMEOUT_MINUTES * 60 * 1000;
  const SESSION_GC_GRACE_MS = config.WAIT_TIMEOUT_MINUTES * 60 * 1000;
  const STALE_SESSION_MS   = 2 * config.WAIT_TIMEOUT_MINUTES * 60 * 1000;

  function sweepSessions(): void {
    const now = Date.now();

    // Build wait-liveness set so GC doesn't reap sessions still polling
    const liveByWait = new Set<string>();
    for (const ds of getDashboardSessions()) {
      if (ds.lastWaitCallAt && now - ds.lastWaitCallAt < WAIT_LIVENESS_MS) {
        liveByWait.add(ds.mcpSessionId);
      }
    }

    let marked = 0;
    let removed = 0;
    let reaped = 0;

    for (const [sid, entry] of sessions) {
      // 1. Close truly stale transports (was session-reaper)
      if (entry.transport && now - entry.lastActivity > STALE_SESSION_MS) {
        log.info(`[session-sweep] Closing stale session ${sid.slice(0, 8)}… (idle ${Math.round((now - entry.lastActivity) / 60000)}m)`);
        expectMcpSessionClose(sid);
        try { entry.transport.close(); } catch (_) { /* best-effort */ }
        void closeSessionServer(entry);
        sessions.delete(sid);
        removeDashboardSession(sid);
        reaped++;
        continue;
      }

      // 2. Mark idle active sessions as disconnected (was TTL sweeper)
      if (entry.status === "active" && !entry.transport) {
        entry.status = "disconnected";
        if (entry.disconnectedAt == null) entry.disconnectedAt = now;
        markDashboardSessionDisconnected(sid);
        marked++;
      } else if (entry.status === "active" && now - entry.lastActivity > SESSION_IDLE_TTL_MS) {
        log.info(`[session-sweep] Marking session ${sid.slice(0, 8)}… as disconnected (idle ${Math.round((now - entry.lastActivity) / 60000)}m)`);
        entry.status = "disconnected";
        entry.disconnectedAt = now;
        markDashboardSessionDisconnected(sid);
        marked++;
      }

      // 3. GC disconnected sessions past grace period (was session-gc)
      if (
        entry.disconnectedAt != null &&
        now - entry.disconnectedAt > SESSION_GC_GRACE_MS &&
        !liveByWait.has(sid) &&
        entry.status !== "active" &&
        !entry.transport
      ) {
        void closeSessionServer(entry);
        sessions.delete(sid);
        removeDashboardSession(sid);
        removed++;
      }
    }

    if (marked > 0 || removed > 0 || reaped > 0) {
      log.info(`[session-sweep] marked=${marked} removed=${removed} reaped=${reaped}`);
    }
  }

  const sessionSweepInterval = setInterval(sweepSessions, 60 * 1000);

  // ── Graceful shutdown — abort in-flight TTS, drain, then exit ──────────
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[shutdown] Graceful shutdown initiated (${reason})…`);

    clearInterval(sessionSweepInterval);

    // Tear down transports and HTTP server.
    for (const [sid, entry] of sessions) {
      if (entry.transport) {
        expectMcpSessionClose(sid);
        try { entry.transport.close(); } catch (_) { /* best-effort */ }
      }
      if (entry.server) {
        try { await entry.server.close(); } catch (_) { /* best-effort */ }
      }
      sessions.delete(sid);
    }
    httpServer.close();
    closeMemoryDb();
    process.exit(0);
  };
  process.on("SIGINT",  () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => { void shutdown("SIGBREAK"); });
  }
}
