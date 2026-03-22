/**
 * Dashboard — Beautiful web UI for monitoring sensorium-mcp agent sessions.
 *
 * Architecture:
 *   GET /                → Serve the SPA (single-page HTML with embedded CSS/JS)
 *   GET /api/status      → Memory stats + session overview
 *   GET /api/sessions    → Active MCP sessions
 *   GET /api/notes       → Browse semantic notes (query params: type, limit, sort)
 *   GET /api/episodes    → Recent episodes (query params: threadId, limit)
 *   GET /api/topics      → Topic index
 *   GET /api/search      → Search notes (query param: q)
 *
 * All /api/* routes require Bearer token auth (same as MCP_HTTP_SECRET).
 * The dashboard page itself is served without auth — API token entered in the UI.
 */

import type { Database } from "better-sqlite3";
import type { IncomingMessage, ServerResponse } from "node:http";

import { readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    getRecentEpisodes,
    getTopicIndex,
    getTopSemanticNotes,
    searchSemanticNotesRanked,
    type SemanticNote
} from "./memory.js";

// Embedded default template — used when the file-system copy is unavailable
// (e.g. after `npm install` where templates/ isn't in the package).
const DEFAULT_REMINDERS_TEMPLATE = `<!-- 
  Default reminders template for remote-copilot-mcp.
  
  Copy this file to ~/.remote-copilot-mcp/templates/reminders.md to activate.
  Customize the text as needed — the hardcoded fallback will no longer be used
  once the template file exists.

  Supported variables (replaced at render time):
    {{OPERATOR_MESSAGE}}  — the operator's latest message text (may be empty)
    {{THREAD_ID}}         — current Telegram thread ID (or "?" if unset)
    {{TIME}}              — formatted timestamp, e.g. "21 Mar 2026, 14:05 GMT"
    {{UPTIME}}            — session uptime string, e.g. "12m"
    {{VERSION}}           — package version from package.json
    {{MODE}}              — "autonomous" or "standard"
-->

You are the ORCHESTRATOR. Your only permitted actions: plan, decide, call wait_for_instructions/hibernate/send_voice/report_progress/memory tools. ALL other work (file reads, edits, searches, code changes) MUST go through runSubagent. Non-negotiable. threadId={{THREAD_ID}} | {{TIME}} | uptime: {{UPTIME}}
`;

// Embedded default drive template presets — used when the on-disk files are unavailable
const DEFAULT_DRIVE_PRESETS: Record<string, string> = {
    "operator-instruction": `The operator left this instruction before stepping away:

"I'll be away for {{IDLE_HOURS}} hours. The session is yours \u2014 you have all the tools, full memory access, and complete autonomy. Pick something meaningful and go for it."

What do you want to do? Pick at least one action and execute it.
`,
    "operator-notes": `The operator stepped away {{IDLE_HOURS}} hours ago and left you this note:

"You're free to work on whatever you find most interesting or valuable. Use your memory, search the codebase, or explore something new."

What catches your attention? Pick at least one action and go for it.
`,
    "dispatcher": `\u26A1 DISPATCHER \u2014 Operator away {{IDLE_HOURS}}h

The session is yours. You have complete autonomy and all tools available.

What do you want to do? Pick at least one action. Report progress when done, then call wait_for_instructions.
`,
    "first-person": `The operator has been away {{IDLE_HOURS}} hours. I'm free to pursue whatever interests me.

I have all the tools and full memory access. What should I explore?

(If nothing interests me, I should say so \u2014 that's useful diagnostic information.)
`,
};

const DRIVE_PRESET_DEFS = [
    { name: "Direct Instruction", key: "operator-instruction" },
    { name: "Operator Notes", key: "operator-notes" },
    { name: "Dispatcher", key: "dispatcher" },
    { name: "First Person", key: "first-person" },
];

async function loadDrivePresets(): Promise<Array<{ name: string; key: string; content: string }>> {
    const presets: Array<{ name: string; key: string; content: string }> = [];
    for (const def of DRIVE_PRESET_DEFS) {
        let content: string;
        try {
            const defaultFile = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", `drive-${def.key}.default.md`);
            content = await readFile(defaultFile, "utf-8");
        } catch {
            content = DEFAULT_DRIVE_PRESETS[def.key] ?? `(default template for ${def.key} not found)`;
        }
        presets.push({ name: def.name, key: def.key, content });
    }
    return presets;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DashboardContext {
    getDb: () => Database;
    getActiveSessions: () => Array<{
        threadId: number;
        mcpSessionId: string;
        lastActivity: number;
        transportType: string;
        status: "active" | "disconnected";
    }>;
    serverStartTime: number;
}

// ─── Route handler ───────────────────────────────────────────────────────────

/**
 * Handle a dashboard or API request. Returns true if handled, false if not a dashboard route.
 */
export function handleDashboardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: DashboardContext,
    authToken?: string
): boolean {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Serve dashboard SPA
    if (path === "/" || path === "/dashboard") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getDashboardHTML());
        return true;
    }

    // All /api/* routes require auth
    if (path.startsWith("/api/")) {
        if (authToken) {
            const auth = req.headers.authorization;
            const providedToken = auth?.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token");
            if (!providedToken || providedToken !== authToken) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Unauthorized" }));
                return true;
            }
        }
        return handleApiRoute(req, path, url, res, ctx);
    }

    return false;
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

function handleApiRoute(
    req: IncomingMessage,
    path: string,
    url: URL,
    res: ServerResponse,
    ctx: DashboardContext
): boolean {
    const json = (data: unknown, status = 200) => {
        res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify(data));
    };

    try {
        const db = ctx.getDb();

        if (path === "/api/status") {
            const totalEpisodes = (db.prepare(`SELECT COUNT(*) as cnt FROM episodes`).get() as { cnt: number }).cnt;
            const unconsolidatedEpisodes = (db.prepare(`SELECT COUNT(*) as cnt FROM episodes WHERE consolidated = 0`).get() as { cnt: number }).cnt;
            const totalSemanticNotes = (db.prepare(`SELECT COUNT(*) as cnt FROM semantic_notes WHERE valid_to IS NULL AND superseded_by IS NULL`).get() as { cnt: number }).cnt;
            const totalProcedures = (db.prepare(`SELECT COUNT(*) as cnt FROM procedures`).get() as { cnt: number }).cnt;
            const totalVoiceSignatures = (db.prepare(`SELECT COUNT(*) as cnt FROM voice_signatures`).get() as { cnt: number }).cnt;
            const lastConso = db.prepare(`SELECT run_at FROM meta_consolidation_log ORDER BY run_at DESC LIMIT 1`).get() as { run_at: string } | undefined;
            const topTopics = getTopicIndex(db).slice(0, 10);
            const dbSizeRow = db.prepare(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`).get() as { size: number } | undefined;
            const sessions = ctx.getActiveSessions();
            json({
                memory: { totalEpisodes, unconsolidatedEpisodes, totalSemanticNotes, totalProcedures, totalVoiceSignatures, lastConsolidation: lastConso?.run_at ?? null, topTopics, dbSizeBytes: dbSizeRow?.size ?? 0 },
                activeSessions: sessions.length,
                sessions,
                uptime: Math.floor((Date.now() - ctx.serverStartTime) / 1000),
                serverTime: new Date().toISOString(),
            });
            return true;
        }

        if (path === "/api/sessions") {
            json(ctx.getActiveSessions());
            return true;
        }

        if (path === "/api/notes") {
            const type = url.searchParams.get("type") || undefined;
            const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
            const sort = (url.searchParams.get("sort") ?? "created_at") as "created_at" | "confidence" | "access_count";
            const validTypes = ["fact", "preference", "pattern", "entity", "relationship"];
            const notes = getTopSemanticNotes(db, {
                type: type && validTypes.includes(type) ? type as SemanticNote["type"] : undefined,
                limit: Math.min(limit, 200),
                sortBy: sort,
            });
            json(notes);
            return true;
        }

        if (path === "/api/episodes") {
            const threadId = url.searchParams.get("threadId") ? parseInt(url.searchParams.get("threadId")!, 10) : undefined;
            const limit = parseInt(url.searchParams.get("limit") ?? "30", 10);
            const cappedLimit = Math.min(limit, 200);
            if (threadId) {
                json(getRecentEpisodes(db, threadId, cappedLimit));
            } else {
                const rows = db.prepare(`SELECT * FROM episodes ORDER BY timestamp DESC LIMIT ?`).all(cappedLimit) as Record<string, unknown>[];
                json(rows.map((r) => ({
                    episodeId: r.episode_id, threadId: r.thread_id, type: r.type, modality: r.modality,
                    content: typeof r.content === "string" ? safeParseJSON(r.content) : r.content,
                    importance: r.importance, consolidated: !!r.consolidated, createdAt: r.timestamp,
                })));
            }
            return true;
        }

        if (path === "/api/topics") {
            json(getTopicIndex(db));
            return true;
        }

        if (path === "/api/search") {
            const q = url.searchParams.get("q")?.trim();
            if (!q) { json({ error: "Missing ?q= parameter" }, 400); return true; }
            json(searchSemanticNotesRanked(db, q, { maxResults: parseInt(url.searchParams.get("limit") ?? "20", 10) }));
            return true;
        }

        // ── Template API endpoints ──────────────────────────────────
        if (path === "/api/templates" && req.method === "GET") {
            void (async () => {
                try {
                    const templatesDir = join(homedir(), ".remote-copilot-mcp", "templates");
                    const userFile = join(templatesDir, "reminders.md");
                    let content: string;
                    let isDefault = false;
                    try {
                        content = await readFile(userFile, "utf-8");
                    } catch {
                        // Try the on-disk default first (works in dev / git clone)
                        try {
                            const defaultFile = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "reminders.default.md");
                            content = await readFile(defaultFile, "utf-8");
                        } catch {
                            // File not available (e.g. npm package) — use embedded copy
                            content = DEFAULT_REMINDERS_TEMPLATE;
                        }
                        isDefault = true;
                    }
                    json({ templates: [{ name: "reminders", content, isDefault }] });
                } catch (err) {
                    json({ error: err instanceof Error ? err.message : String(err) }, 500);
                }
            })();
            return true;
        }

        // ── Drive template endpoints ────────────────────────────────
        if (path === "/api/templates/drive" && req.method === "GET") {
            void (async () => {
                try {
                    const templatesDir = join(homedir(), ".remote-copilot-mcp", "templates");
                    const userFile = join(templatesDir, "drive.md");
                    let content: string | null = null;
                    let isDefault = true;
                    try {
                        content = await readFile(userFile, "utf-8");
                        isDefault = false;
                    } catch {
                        content = null;
                    }
                    json({ content, isDefault });
                } catch (err) {
                    json({ error: err instanceof Error ? err.message : String(err) }, 500);
                }
            })();
            return true;
        }

        if (path === "/api/templates/drive-presets" && req.method === "GET") {
            void (async () => {
                try {
                    const presets = await loadDrivePresets();
                    json({ presets });
                } catch (err) {
                    json({ error: err instanceof Error ? err.message : String(err) }, 500);
                }
            })();
            return true;
        }

        if (path === "/api/settings/dmn-activation-hours" && req.method === "GET") {
            const rawVal = parseFloat(process.env.DMN_ACTIVATION_HOURS ?? "");
            json({ value: Math.max(0.5, Number.isFinite(rawVal) ? rawVal : 4) });
            return true;
        }

        const templateMatch = path.match(/^\/api\/templates\/([a-zA-Z0-9-]+)$/);
        if (templateMatch) {
            const name = templateMatch[1];

            if (req.method === "POST") {
                void (async () => {
                    try {
                        const body = await readBody(req);
                        const parsed = JSON.parse(body) as { content?: string };
                        if (typeof parsed.content !== "string") {
                            json({ error: "Missing content field" }, 400);
                            return;
                        }
                        const templatesDir = join(homedir(), ".remote-copilot-mcp", "templates");
                        await mkdir(templatesDir, { recursive: true });
                        await writeFile(join(templatesDir, `${name}.md`), parsed.content, "utf-8");
                        json({ ok: true });
                    } catch (err) {
                        json({ error: err instanceof Error ? err.message : String(err) }, 500);
                    }
                })();
                return true;
            }

            if (req.method === "DELETE") {
                void (async () => {
                    try {
                        const templatesDir = join(homedir(), ".remote-copilot-mcp", "templates");
                        try { await unlink(join(templatesDir, `${name}.md`)); } catch { /* ok if missing */ }
                        json({ ok: true });
                    } catch (err) {
                        json({ error: err instanceof Error ? err.message : String(err) }, 500);
                    }
                })();
                return true;
            }
        }

        json({ error: "Not found" }, 404);
        return true;
    } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) }, 500);
        return true;
    }
}

function safeParseJSON(s: string): unknown {
    try { return JSON.parse(s); } catch { return s; }
}

// ─── Dashboard SPA HTML ──────────────────────────────────────────────────────

let _dashboardHtmlCache: string | null = null;

function getDashboardHTML(): string {
    if (_dashboardHtmlCache) return _dashboardHtmlCache;

    const __dir = dirname(fileURLToPath(import.meta.url));
    // In dev (tsx): __dir = src/  → src/dashboard/spa.html
    // In prod (node): __dir = dist/ → try dist/dashboard/spa.html, fall back to src/dashboard/spa.html
    const candidates = [
        join(__dir, "dashboard", "spa.html"),
        join(__dir, "..", "src", "dashboard", "spa.html"),
    ];

    for (const p of candidates) {
        try {
            _dashboardHtmlCache = readFileSync(p, "utf-8");
            return _dashboardHtmlCache;
        } catch { /* try next */ }
    }

    throw new Error("Dashboard SPA HTML not found. Searched: " + candidates.join(", "));
}