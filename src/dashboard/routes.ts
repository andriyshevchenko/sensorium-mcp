/**
 * Dashboard — API route dispatcher and SPA serving.
 *
 * Architecture:
 *   GET /                → Serve the SPA (single-page HTML with embedded CSS/JS)
 *   GET /api/*           → Route table dispatch to domain handlers
 *
 * Domain handler modules:
 *   routes/settings.ts   — agent-type, dmn-activation-hours, claude-mcp-config
 *   routes/templates.ts  — template CRUD, drive templates, drive presets
 *   routes/data.ts       — status, sessions, notes, episodes, topics, search, topic-registry
 *
 * All /api/* routes require Bearer token auth (same as MCP_HTTP_SECRET).
 * The dashboard page itself is served without auth — API token entered in the UI.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

// Re-export types for downstream consumers (http-server.ts → dashboard.ts → here)
export type { DashboardContext } from "./routes/types.js";
export type { RouteHandler, RouteArgs, JsonFn } from "./routes/types.js";

import type { DashboardContext } from "./routes/types.js";
import type { RouteHandler } from "./routes/types.js";

// Domain handlers — settings
import {
    handleGetDmnActivationHours,
    handleGetClaudeMcpConfig,
    handlePostClaudeMcpConfig,
    handleGetAgentType,
    handlePostAgentType,
    handleGetThreadAgentTypes,
    handlePostThreadAgentType,
    handleGetGuardrailsEnabled,
    handlePostGuardrailsEnabled,
    handleGetBootstrapMessageCount,
    handlePostBootstrapMessageCount,
    handleGetKeepAlive,
    handlePostKeepAlive,
    handleGetThreadKeepAlive,
    handlePostThreadKeepAlive,
} from "./routes/settings.js";

// Domain handlers — templates
import {
    handleGetTemplates,
    handleGetDriveTemplate,
    handleGetDrivePresets,
    handleTemplateCrud,
} from "./routes/templates.js";

// Domain handlers — data
import {
    handleGetStatus,
    handleGetSessions,
    handleGetNotes,
    handleGetEpisodes,
    handleGetTopics,
    handleGetSearch,
    handleGetTopicRegistry,
    handlePostTopicRegistry,
    handleDeleteTopicRegistry,
} from "./routes/data.js";

// Domain handlers — skills
import {
    handleGetSkills,
    handleSkillDelete,
    handleSkillPut,
} from "./routes/skills.js";

// Domain handlers — threads
import {
    handleGetThreads,
    handleGetRootThreads,
    handleCreateThread,
    handleGetThread,
    handleGetThreadChildren,
    handleGetThreadRunning,
    handleGetThreadHeartbeat,
    handleUpdateThread,
    handleDeleteThread,
} from "./routes/threads.js";

// ─── Route table ────────────────────────────────────────────────────────────

const routeTable: Record<string, RouteHandler> = {
    // Data
    "GET /api/status":       handleGetStatus,
    "GET /api/sessions":     handleGetSessions,
    "GET /api/notes":        handleGetNotes,
    "GET /api/episodes":     handleGetEpisodes,
    "GET /api/topics":       handleGetTopics,
    "GET /api/search":       handleGetSearch,

    // Templates
    "GET /api/templates":              handleGetTemplates,
    "GET /api/templates/drive":        handleGetDriveTemplate,
    "GET /api/templates/drive-presets": handleGetDrivePresets,

    // Settings
    "GET /api/settings/dmn-activation-hours":  handleGetDmnActivationHours,
    "GET /api/settings/claude-mcp-config":     handleGetClaudeMcpConfig,
    "POST /api/settings/claude-mcp-config":    handlePostClaudeMcpConfig,
    "GET /api/settings/agent-type":            handleGetAgentType,
    "POST /api/settings/agent-type":           handlePostAgentType,
    "GET /api/settings/thread-agent-types":    handleGetThreadAgentTypes,
    "POST /api/settings/thread-agent-type":    handlePostThreadAgentType,
    "GET /api/settings/guardrails":               handleGetGuardrailsEnabled,
    "POST /api/settings/guardrails":              handlePostGuardrailsEnabled,
    "GET /api/settings/bootstrap-message-count":  handleGetBootstrapMessageCount,
    "POST /api/settings/bootstrap-message-count": handlePostBootstrapMessageCount,
    "GET /api/settings/keep-alive":               handleGetKeepAlive,
    "POST /api/settings/keep-alive":              handlePostKeepAlive,
    "GET /api/settings/thread-keep-alive":        handleGetThreadKeepAlive,
    "POST /api/settings/thread-keep-alive":       handlePostThreadKeepAlive,

    // Topic registry
    "GET /api/topic-registry":    handleGetTopicRegistry,
    "POST /api/topic-registry":   handlePostTopicRegistry,
    "DELETE /api/topic-registry": handleDeleteTopicRegistry,

    // Skills
    "GET /api/skills":            handleGetSkills,

    // Threads
    "GET /api/threads":           handleGetThreads,
    "GET /api/threads/roots":     handleGetRootThreads,
    "POST /api/threads":          handleCreateThread,
};

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Handle a dashboard or API request. Returns true if handled, false if not a dashboard route.
 */
export async function handleDashboardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: DashboardContext,
    authToken?: string,
): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Serve dashboard SPA
    if (path === "/" || path === "/dashboard") {
        const html = getDashboardHTML();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return true;
    }

    // All /api/* routes require auth
    if (path.startsWith("/api/")) {
        if (authToken) {
            const auth = req.headers.authorization;
            const providedToken = auth?.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token");
            if (!providedToken) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Unauthorized" }));
                return true;
            }
            // Use constant-time comparison to prevent timing attacks.
            const providedBuf = Buffer.from(providedToken);
            const expectedBuf = Buffer.from(authToken);
            if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Unauthorized" }));
                return true;
            }
        }
        return await dispatchApiRoute(req, path, url, res, ctx);
    }

    return false;
}

// ─── API route dispatcher ───────────────────────────────────────────────────

async function dispatchApiRoute(
    req: IncomingMessage,
    path: string,
    url: URL,
    res: ServerResponse,
    ctx: DashboardContext,
): Promise<boolean> {
    const json = (data: unknown, status = 200) => {
        const body = JSON.stringify(data);
        res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
        });
        res.end(body);
    };

    try {
        const db = ctx.getDb();
        const method = req.method ?? "GET";
        const key = `${method} ${path}`;
        const args = { req, url, json, db, ctx };

        // 1. Exact match in route table
        const handler = routeTable[key];
        if (handler) return handler(args);

        // 2. Dynamic template route: POST/DELETE /api/templates/:name
        const templateMatch = path.match(/^\/api\/templates\/([\w-]+)$/);
        if (templateMatch) {
            const result = handleTemplateCrud(args, templateMatch[1]);
            if (result) return true;
        }

        // 3. Dynamic skill routes: PUT/DELETE /api/skills/:name
        const skillMatch = path.match(/^\/api\/skills\/([\w-]+)$/);
        if (skillMatch) {
            if (method === "PUT") {
                const result = await handleSkillPut(args, skillMatch[1]);
                if (result) return true;
            }
            if (method === "DELETE") {
                const result = await handleSkillDelete(args, skillMatch[1]);
                if (result) return true;
            }
        }

        // 4. Dynamic thread routes: /api/threads/:threadId[/children|/running]
        const threadChildrenMatch = /^\/api\/threads\/(\d+)\/children$/.exec(path);
        if (threadChildrenMatch) {
            return handleGetThreadChildren(args, Number.parseInt(threadChildrenMatch[1], 10));
        }
        const threadRunningMatch = /^\/api\/threads\/(\d+)\/running$/.exec(path);
        if (threadRunningMatch) {
            return handleGetThreadRunning(args, Number.parseInt(threadRunningMatch[1], 10));
        }
        const threadHeartbeatMatch = /^\/api\/threads\/(\d+)\/heartbeat$/.exec(path);
        if (threadHeartbeatMatch) {
            return handleGetThreadHeartbeat(args, Number.parseInt(threadHeartbeatMatch[1], 10));
        }
        const threadMatch = /^\/api\/threads\/(\d+)$/.exec(path);
        if (threadMatch) {
            const tid = Number.parseInt(threadMatch[1], 10);
            if (method === "GET") return handleGetThread(args, tid);
            if (method === "PATCH") return handleUpdateThread(args, tid);
            if (method === "DELETE") return handleDeleteThread(args, tid);
        }

        json({ error: "Not found" }, 404);
        return true;
    } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) }, 500);
        return true;
    }
}

// ─── Dashboard SPA HTML ─────────────────────────────────────────────────────

let _dashboardHtmlCache: string | null = null;

function getDashboardHTML(): string {
    if (_dashboardHtmlCache) return _dashboardHtmlCache;

    const __dir = dirname(fileURLToPath(import.meta.url));
    // In dev (tsx): __dir = src/dashboard/  → src/dashboard/spa.html
    // In prod (node): __dir = dist/dashboard/ → try dist/dashboard/spa.html, fall back to src/dashboard/spa.html
    const candidates = [
        join(__dir, "spa.html"),
        join(__dir, "..", "..", "src", "dashboard", "spa.html"),
    ];

    for (const p of candidates) {
        try {
            _dashboardHtmlCache = readFileSync(p, "utf-8");
            return _dashboardHtmlCache;
        } catch { /* try next */ }
    }

    throw new Error("Dashboard SPA HTML not found. Searched: " + candidates.join(", "));
}
