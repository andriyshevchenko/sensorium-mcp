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
import { checkMaintenanceFlag } from "./data/file-storage.js";
import { abortPendingSpeech, pendingSpeechCount } from "./integrations/openai/speech.js";
import { log } from "./logger.js";
import { handleDashboardRequest, type DashboardContext } from "./dashboard.js";
import {
  registerDashboardSession,
  updateDashboardActivity,
  markDashboardSessionDisconnected,
  removeDashboardSession,
  getDashboardSessions,
  WAIT_LIVENESS_MS,
} from "./sessions.js";
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
  /** Records the epoch ms when a session became disconnected (for GC). */
  const sessionDisconnectedAt = new Map<string, number>();

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
        return getDashboardSessions();
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
        sessionDisconnectedAt.delete(sessionId);
        updateDashboardActivity(sessionId);
        await transports.get(sessionId)!.handleRequest(req, res, body);
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
          sessionLastActivity.delete(sessionId);
          sessionStatus.delete(sessionId);
          sessionDisconnectedAt.delete(sessionId);
          removeDashboardSession(sessionId);
        }

        let capturedSid: string | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            capturedSid = sid;
            transports.set(sid, transport);
            sessionLastActivity.set(sid, Date.now());
            sessionStatus.set(sid, "active");
            registerDashboardSession(sid, "http");
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            transports.delete(sid);
            // Keep in sessionLastActivity & sessionStatus for dashboard visibility
            sessionStatus.set(sid, "disconnected");
            sessionDisconnectedAt.set(sid, Date.now());
            markDashboardSessionDisconnected(sid);
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
          if (!sessionDisconnectedAt.has(sseSid)) {
            sessionDisconnectedAt.set(sseSid, Date.now());
          }
          markDashboardSessionDisconnected(sseSid);
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
  // Use the configured wait timeout so sessions waiting up to WAIT_TIMEOUT_MINUTES aren't prematurely marked dead
  const SESSION_IDLE_TTL_MS = config.WAIT_TIMEOUT_MINUTES * 60 * 1000;
  const ttlSweeperInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, status] of sessionStatus) {
      if (status === "active" && !transports.has(sid)) {
        // Transport already gone but status wasn't updated — fix it
        sessionStatus.set(sid, "disconnected");
        if (!sessionDisconnectedAt.has(sid)) {
          sessionDisconnectedAt.set(sid, now);
        }
        markDashboardSessionDisconnected(sid);
      } else if (status === "active") {
        const lastActive = sessionLastActivity.get(sid) ?? 0;
        if (now - lastActive > SESSION_IDLE_TTL_MS) {
          log.info(`[session-ttl] Marking session ${sid.slice(0, 8)} as disconnected (idle ${Math.round((now - lastActive) / 60000)}m)`);
          sessionStatus.set(sid, "disconnected");
          sessionDisconnectedAt.set(sid, now);
          markDashboardSessionDisconnected(sid);
        }
      }
    }
  }, 5 * 60 * 1000);

  // ── Session GC — remove disconnected sessions after grace period ─────────
  // Sessions with a recent lastWaitCallAt (within WAIT_LIVENESS_MS) are
  // considered "truly alive" even if the transport shows disconnected.
  // Grace period matches wait timeout so long-polling sessions aren't reaped.
  const SESSION_GC_GRACE_MS = config.WAIT_TIMEOUT_MINUTES * 60 * 1000;
  const sessionGcInterval = setInterval(() => {
    const now = Date.now();
    let removed = 0;
    // Check global dashboard sessions for wait-liveness before GC
    const liveByWait = new Set<string>();
    for (const ds of getDashboardSessions()) {
      if (ds.lastWaitCallAt && now - ds.lastWaitCallAt < WAIT_LIVENESS_MS) {
        liveByWait.add(ds.mcpSessionId);
      }
    }
    for (const [sid, disconnectTime] of sessionDisconnectedAt) {
      if (now - disconnectTime > SESSION_GC_GRACE_MS) {
        // Skip GC if session is still alive via wait heartbeat
        if (liveByWait.has(sid)) continue;
        // Only GC if actually disconnected (safety check)
        if (sessionStatus.get(sid) !== "active" && !transports.has(sid)) {
          sessionStatus.delete(sid);
          sessionLastActivity.delete(sid);
          sessionDisconnectedAt.delete(sid);
          removeDashboardSession(sid);
          removed++;
        }
      }
    }
    if (removed > 0) {
      log.info(`[session-gc] Removed ${removed} disconnected session(s)`);
    }
  }, 60 * 1000);

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
        removeDashboardSession(sid);
      }
    }
    // Also purge long-disconnected sessions from tracking maps
    for (const [sid, status] of sessionStatus) {
      if (status === "disconnected" && !transports.has(sid)) {
        const lastActive = sessionLastActivity.get(sid) ?? 0;
        if (now - lastActive > STALE_SESSION_MS) {
          sessionLastActivity.delete(sid);
          sessionStatus.delete(sid);
          sessionDisconnectedAt.delete(sid);
          removeDashboardSession(sid);
        }
      }
    }
  }, 10 * 60 * 1000);

  // ── Graceful shutdown — abort in-flight TTS, drain, then exit ──────────
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[shutdown] Graceful shutdown initiated (${reason}) — aborting in-flight TTS…`);

    clearInterval(ttlSweeperInterval);
    clearInterval(sessionGcInterval);
    clearInterval(sessionReaperInterval);
    clearInterval(maintenancePollInterval);

    // 1. Abort any pending TTS / transcription requests so they fail fast.
    abortPendingSpeech();

    // 2. Brief drain: wait up to 3 s for in-flight speech handlers to
    //    propagate their abort errors back through the HTTP response.
    const deadline = Date.now() + 3_000;
    while (pendingSpeechCount() > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }

    // 3. Tear down transports and HTTP server.
    for (const [sid, t] of transports) {
      try { t.close(); } catch (_) { /* best-effort */ }
      transports.delete(sid);
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
  process.on("exit", () => { closeMemoryDb(); });

  // ── Maintenance flag poller — self-terminate before the update watcher
  //    force-kills us, giving in-flight requests a chance to complete. ────
  const maintenancePollInterval = setInterval(() => {
    if (shuttingDown) return;
    if (checkMaintenanceFlag()) {
      void shutdown("maintenance flag detected");
    }
  }, 2_000);
}
