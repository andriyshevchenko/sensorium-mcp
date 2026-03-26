/**
 * Dashboard API — data-related route handlers.
 * Covers: status, sessions, notes, episodes, topics, search, topic-registry.
 */

import {
    getRecentEpisodes,
    getTopicIndex,
    getTopSemanticNotes,
    searchSemanticNotesRanked,
    type SemanticNote,
} from "../../memory.js";

import { getAllRegisteredTopics, registerTopic, unregisterTopic } from "../../sessions.js";

import { readBody, safeParseJSON, type RouteHandler } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Enrich session objects with topic names by reverse-looking up threadId
 * in the topic registry.
 */
function enrichSessionsWithTopicNames<T extends { threadId: number | null }>(
    sessions: T[],
): (T & { topicName: string | null })[] {
    const allTopics = getAllRegisteredTopics();
    // Build reverse map: threadId → topic name
    const threadToName = new Map<number, string>();
    for (const chatId of Object.keys(allTopics)) {
        for (const [name, tid] of Object.entries(allTopics[chatId])) {
            threadToName.set(tid, name);
        }
    }
    return sessions.map((s) => ({ ...s, topicName: s.threadId != null ? (threadToName.get(s.threadId) ?? null) : null }));
}

// ─── GET /api/status — memory stats + session overview ──────────────────────

export const handleGetStatus: RouteHandler = ({ json, db, ctx }) => {
    const totalEpisodes = (db.prepare(`SELECT COUNT(*) as cnt FROM episodes`).get() as { cnt: number }).cnt;
    const unconsolidatedEpisodes = (db.prepare(`SELECT COUNT(*) as cnt FROM episodes WHERE consolidated = 0`).get() as { cnt: number }).cnt;
    const totalSemanticNotes = (db.prepare(`SELECT COUNT(*) as cnt FROM semantic_notes WHERE valid_to IS NULL AND superseded_by IS NULL`).get() as { cnt: number }).cnt;
    const totalProcedures = (db.prepare(`SELECT COUNT(*) as cnt FROM procedures`).get() as { cnt: number }).cnt;
    const totalVoiceSignatures = (db.prepare(`SELECT COUNT(*) as cnt FROM voice_signatures`).get() as { cnt: number }).cnt;
    const lastConso = db.prepare(`SELECT run_at FROM meta_consolidation_log ORDER BY run_at DESC LIMIT 1`).get() as { run_at: string } | undefined;
    const topTopics = getTopicIndex(db).slice(0, 10);
    const dbSizeRow = db.prepare(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`).get() as { size: number } | undefined;
    const sessions = enrichSessionsWithTopicNames(ctx.getActiveSessions());
    json({
        memory: {
            totalEpisodes, unconsolidatedEpisodes, totalSemanticNotes,
            totalProcedures, totalVoiceSignatures,
            lastConsolidation: lastConso?.run_at ?? null,
            topTopics, dbSizeBytes: dbSizeRow?.size ?? 0,
        },
        activeSessions: sessions.length,
        sessions,
        uptime: Math.floor((Date.now() - ctx.serverStartTime) / 1000),
        serverTime: new Date().toISOString(),
    });
    return true;
};

// ─── GET /api/sessions — active MCP sessions ───────────────────────────────

export const handleGetSessions: RouteHandler = ({ json, ctx }) => {
    json(enrichSessionsWithTopicNames(ctx.getActiveSessions()));
    return true;
};

// ─── GET /api/notes — browse semantic notes ─────────────────────────────────

export const handleGetNotes: RouteHandler = ({ url, json, db }) => {
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
};

// ─── GET /api/episodes — recent episodes ────────────────────────────────────

export const handleGetEpisodes: RouteHandler = ({ url, json, db }) => {
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
};

// ─── GET /api/topics — topic index ──────────────────────────────────────────

export const handleGetTopics: RouteHandler = ({ json, db }) => {
    json(getTopicIndex(db));
    return true;
};

// ─── GET /api/search — search semantic notes ────────────────────────────────

export const handleGetSearch: RouteHandler = ({ url, json, db }) => {
    const q = url.searchParams.get("q")?.trim();
    if (!q) { json({ error: "Missing ?q= parameter" }, 400); return true; }
    json(searchSemanticNotesRanked(db, q, { maxResults: parseInt(url.searchParams.get("limit") ?? "20", 10) }));
    return true;
};

// ─── Topic registry endpoints ───────────────────────────────────────────────

export const handleGetTopicRegistry: RouteHandler = ({ url, json }) => {
    const chatId = url.searchParams.get("chatId") ?? undefined;
    json(getAllRegisteredTopics(chatId));
    return true;
};

export const handlePostTopicRegistry: RouteHandler = ({ req, json }) => {
    void (async () => {
        try {
            const body = await readBody(req);
            const parsed = JSON.parse(body) as { chatId?: string; name?: string; threadId?: number };
            if (!parsed.chatId || typeof parsed.chatId !== "string") {
                json({ error: "Missing or invalid chatId" }, 400);
                return;
            }
            if (!parsed.name || typeof parsed.name !== "string") {
                json({ error: "Missing or invalid name" }, 400);
                return;
            }
            if (parsed.threadId == null || !Number.isFinite(parsed.threadId)) {
                json({ error: "Missing or invalid threadId (must be a number)" }, 400);
                return;
            }
            registerTopic(parsed.chatId, parsed.name.trim(), parsed.threadId);
            json({ ok: true, chatId: parsed.chatId, name: parsed.name.trim().toLowerCase(), threadId: parsed.threadId });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
};

export const handleDeleteTopicRegistry: RouteHandler = ({ req, json }) => {
    void (async () => {
        try {
            const body = await readBody(req);
            const parsed = JSON.parse(body) as { chatId?: string; name?: string };
            if (!parsed.chatId || typeof parsed.chatId !== "string") {
                json({ error: "Missing or invalid chatId" }, 400);
                return;
            }
            if (!parsed.name || typeof parsed.name !== "string") {
                json({ error: "Missing or invalid name" }, 400);
                return;
            }
            unregisterTopic(parsed.chatId, parsed.name.trim());
            json({ ok: true });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
};
