/**
 * Dashboard API — thread registry route handlers.
 * Covers: listing, creating, updating, archiving, and deleting threads.
 */

import {
    registerThread,
    getThread,
    getRootThreads,
    getKeepAliveThreads,
    getActiveThreads,
    getThreadsByRoot,
    updateThread,
    archiveThread,
    deleteThread,
    type ThreadRegistryEntry,
} from "../../data/memory/thread-registry.js";
import type { Database } from "../../data/memory/schema.js";

import {
    setKeepAliveEnabled,
    setKeepAliveThreadId,
    setKeepAliveClient,
    setKeepAliveMaxRetries,
    setKeepAliveCooldownMs,
    setThreadKeepAlive,
    removeThreadKeepAlive,
} from "../../config.js";

import { readBody, safeParseJSON, type RouteHandler, type RouteArgs } from "./types.js";
import { errorMessage } from "../../utils.js";
import { isThreadRunning } from "../../tools/thread-lifecycle.js";
import { readThreadHeartbeat } from "../../data/file-storage.js";
import { getExplicitTelegramTopicId, resolveTelegramTopicId } from "../../data/memory/thread-registry.js";
import { config } from "../../config.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_STATUSES = ["active", "archived", "expired", "exited"] as const;
const VALID_CLIENTS = ["claude", "copilot", "codex", "openai_codex", "copilot_claude", "copilot_codex", "cursor"] as const;

/** Extract valid update fields from a request body. Returns an error string on validation failure. */
function buildThreadUpdates(
    body: Record<string, unknown>,
): Partial<Pick<ThreadRegistryEntry, "name" | "status" | "keepAlive" | "dailyRotation" | "autonomousMode" | "client" | "maxRetries" | "cooldownMs" | "badge" | "identityPrompt" | "telegramTopicId" | "workingDirectory">> | string {
    const updates: Partial<Pick<ThreadRegistryEntry, "name" | "status" | "keepAlive" | "dailyRotation" | "autonomousMode" | "client" | "maxRetries" | "cooldownMs" | "badge" | "identityPrompt" | "telegramTopicId" | "workingDirectory">> = {};
    if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
    if (typeof body.status === "string") {
        if (!(VALID_STATUSES as readonly string[]).includes(body.status)) {
            return `status must be one of: ${VALID_STATUSES.join(", ")}`;
        }
        updates.status = body.status as ThreadRegistryEntry["status"];
    }
    if (typeof body.keepAlive === "boolean") updates.keepAlive = body.keepAlive;
    if (typeof body.dailyRotation === "boolean") updates.dailyRotation = body.dailyRotation;
    if (typeof body.autonomousMode === "boolean") updates.autonomousMode = body.autonomousMode;
    if (typeof body.client === "string") {
        if (!(VALID_CLIENTS as readonly string[]).includes(body.client)) {
            return `client must be one of: ${VALID_CLIENTS.join(", ")}`;
        }
        updates.client = body.client;
    }
    if (typeof body.maxRetries === "number") {
        if (!Number.isFinite(body.maxRetries) || !Number.isInteger(body.maxRetries) || body.maxRetries < 0) {
            return "maxRetries must be a non-negative integer";
        }
        updates.maxRetries = body.maxRetries;
    }
    if (typeof body.cooldownMs === "number") {
        if (!Number.isFinite(body.cooldownMs) || !Number.isInteger(body.cooldownMs) || body.cooldownMs < 0) {
            return "cooldownMs must be a non-negative integer";
        }
        updates.cooldownMs = body.cooldownMs;
    }
    if (typeof body.badge === "string") updates.badge = body.badge;
    if (typeof body.identityPrompt === "string") updates.identityPrompt = body.identityPrompt;
    if (body.identityPrompt === null) updates.identityPrompt = null;
    if (typeof body.telegramTopicId === "number" && Number.isFinite(body.telegramTopicId)) updates.telegramTopicId = body.telegramTopicId;
    if (body.telegramTopicId === null) updates.telegramTopicId = null;
    if (typeof body.workingDirectory === "string" && body.workingDirectory.trim()) updates.workingDirectory = body.workingDirectory.trim();
    if (body.workingDirectory === null) updates.workingDirectory = null;
    return updates;
}

/**
 * Enrich thread entries with topic names from topic_registry
 * when the thread name is generic (e.g. "Thread 1234").
 */
function enrichThreadNames(db: Database, threads: ThreadRegistryEntry[]): ThreadRegistryEntry[] {
    const genericPattern = /^Thread \d+$/i;
    const needsEnrichment = threads.filter(t => genericPattern.test(t.name));
    if (needsEnrichment.length === 0) return threads;

    try {
        const topicNames = new Map<number, string>();
        const rows = db.prepare(
            `SELECT thread_id, name FROM topic_registry`
        ).all() as { thread_id: number; name: string }[];
        for (const r of rows) topicNames.set(r.thread_id, r.name);

        return threads.map(t => {
            if (!genericPattern.test(t.name)) return t;
            // Check topic_registry by thread_id or telegramTopicId
            const topicName = topicNames.get(t.telegramTopicId ?? t.threadId) ?? topicNames.get(t.threadId);
            if (topicName) return { ...t, name: topicName };
            return t;
        });
    } catch {
        return threads; // topic_registry might not exist
    }
}

// ─── GET /api/threads — list all active threads grouped ─────────────────────

export const handleGetThreads: RouteHandler = ({ json, db }) => {
    const threads = enrichThreadNames(db, getActiveThreads(db));
    json({ threads });
    return true;
};

// ─── GET /api/threads/roots — list root threads only ────────────────────────

export const handleGetRootThreads: RouteHandler = ({ json, db }) => {
    json({ threads: enrichThreadNames(db, getRootThreads(db)) });
    return true;
};

// ─── GET /api/threads/keepalive — list all threads with keepAlive=true (excl. workers) ─

export const handleGetKeepAliveThreads: RouteHandler = ({ json, db }) => {
    json({ threads: enrichThreadNames(db, getKeepAliveThreads(db)) });
    return true;
};

// ─── POST /api/threads — create/register a thread ──────────────────────────

export const handleCreateThread: RouteHandler = ({ req, json, db }) => {
    void (async () => {
        try {
            const raw = await readBody(req);
            const body = safeParseJSON(raw) as Record<string, unknown> | null;
            if (!body || typeof body !== "object") {
                json({ error: "Invalid request body" }, 400);
                return;
            }

            const threadId = body.threadId;
            if (typeof threadId !== "number" || !Number.isFinite(threadId) || !Number.isInteger(threadId) || threadId <= 0) {
                json({ error: "threadId must be a positive integer" }, 400);
                return;
            }

            const name = body.name;
            if (typeof name !== "string" || !name.trim()) {
                json({ error: "name is required" }, 400);
                return;
            }

            const validTypes = ["root", "daily", "branch", "worker"] as const;
            const type = body.type;
            if (typeof type !== "string" || !(validTypes as readonly string[]).includes(type)) {
                json({ error: `type must be one of: ${validTypes.join(", ")}` }, 400);
                return;
            }

            const client =
                typeof body.client === "string" && (VALID_CLIENTS as readonly string[]).includes(body.client)
                    ? body.client
                    : undefined;
            const keepAlive = typeof body.keepAlive === "boolean" ? body.keepAlive : undefined;
            const workingDirectory = typeof body.workingDirectory === "string" && body.workingDirectory.trim()
                ? body.workingDirectory.trim()
                : undefined;

            // Check for duplicate
            const existing = getThread(db, threadId);
            if (existing) {
                json({ error: `Thread ${threadId} already exists` }, 409);
                return;
            }

            const entry = registerThread(db, {
                threadId,
                name: name.trim(),
                type: type as ThreadRegistryEntry["type"],
                rootThreadId: typeof body.rootThreadId === "number" ? body.rootThreadId : undefined,
                badge: typeof body.badge === "string" ? body.badge : undefined,
                client,
                keepAlive,
                workingDirectory,
            });

            json(entry, 201);

            // Sync keepAlive to settings.json for watcher backward compatibility
            if (entry.keepAlive) {
                syncKeepAliveToSettings(db);
            }
        } catch (err) {
            json({ error: errorMessage(err) }, 500);
        }
    })();
    return true;
};

// ─── Dynamic handlers (threadId extracted by caller) ────────────────────────

/** GET /api/threads/:threadId — get single thread */
export function handleGetThread(args: RouteArgs, threadId: number): boolean {
    const thread = getThread(args.db, threadId);
    if (thread) {
        args.json(thread);
    } else {
        args.json({ error: `Thread ${threadId} not found` }, 404);
    }
    return true;
}

/** GET /api/threads/:threadId/running — check if an agent process is alive for this thread */
export function handleGetThreadRunning(args: RouteArgs, threadId: number): boolean {
    const running = isThreadRunning(threadId);
    args.json({ threadId, running });
    return true;
}

/** GET /api/threads/:threadId/heartbeat — last MCP activity timestamp for stuck-process detection */
export function handleGetThreadHeartbeat(args: RouteArgs, threadId: number): boolean {
    const lastActivityMs = readThreadHeartbeat(threadId);
    args.json({ threadId, lastActivityMs });
    return true;
}

/** GET /api/threads/:threadId/children — get children of a root */
export function handleGetThreadChildren(args: RouteArgs, rootThreadId: number): boolean {
    const children = getThreadsByRoot(args.db, rootThreadId);
    args.json({ threads: children });
    return true;
}

/** PATCH /api/threads/:threadId — update a thread */
export function handleUpdateThread(args: RouteArgs, threadId: number): boolean {
    const { req, json, db } = args;
    void (async () => {
        try {
            const raw = await readBody(req);
            const body = safeParseJSON(raw) as Record<string, unknown> | null;
            if (!body || typeof body !== "object") {
                json({ error: "Invalid request body" }, 400);
                return;
            }

            const existing = getThread(db, threadId);
            if (!existing) {
                json({ error: `Thread ${threadId} not found` }, 404);
                return;
            }

            const updates = buildThreadUpdates(body);
            if (typeof updates === "string") {
                json({ error: updates }, 400);
                return;
            }

            const updated = updateThread(db, threadId, updates);
            if (!updated) {
                json({ error: "No changes applied" }, 400);
                return;
            }

            json(getThread(db, threadId));

            // Sync keepAlive to settings.json for watcher backward compatibility
            if ("keepAlive" in updates || "client" in updates || "maxRetries" in updates || "cooldownMs" in updates) {
                syncKeepAliveToSettings(db);
            }
        } catch (err) {
            json({ error: errorMessage(err) }, 500);
        }
    })();
    return true;
}

/** DELETE /api/threads/:threadId — archive or delete a thread */
export function handleDeleteThread(args: RouteArgs, threadId: number): boolean {
    const { db, json, url } = args;
    const hard = url.searchParams.get("hard") === "true";

    const existing = getThread(db, threadId);
    if (!existing) {
        json({ error: `Thread ${threadId} not found` }, 404);
        return true;
    }

    if (hard) {
        deleteThread(db, threadId);
        json({ ok: true, action: "deleted", threadId });
    } else {
        archiveThread(db, threadId);
        json({ ok: true, action: "archived", threadId });
    }

    // When archiving an active worker, also disable keepAlive on its root
    // so the supervisor keeper stops restarting it.
    if (existing.type === "worker" && existing.rootThreadId) {
        const root = getThread(db, existing.rootThreadId);
        if (root?.keepAlive) {
            updateThread(db, existing.rootThreadId, { keepAlive: false });
        }
    }

    // Delete Telegram topic (best-effort, async)
    deleteTelegramTopic(db, threadId);

    syncKeepAliveToSettings(db);
    return true;
}

/** Best-effort deletion of a Telegram forum topic for a thread. */
function deleteTelegramTopic(db: Database, threadId: number): void {
    const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = config;
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    void (async () => {
        try {
            const thread = getThread(db, threadId);
            const topicId = thread?.type === 'worker'
                ? getExplicitTelegramTopicId(db, threadId)
                : resolveTelegramTopicId(db, threadId);
            if (topicId == null) return;
            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteForumTopic`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_thread_id: topicId }),
                signal: AbortSignal.timeout(10_000),
            });
        } catch { /* topic might not exist or already deleted */ }
    })();
}

// ─── Settings.json sync for watcher backward compatibility ──────────────────

/**
 * Sync thread_registry keepAlive settings to settings.json for watcher backward compatibility.
 * The watcher's readKeeperSettingsFromFile() reads settings.json during startup before the MCP server is ready.
 */
function syncKeepAliveToSettings(db: Database): void {
    try {
        const allThreads = getActiveThreads(db);
        const activeKeepAlive = allThreads.find(r => r.keepAlive);

        if (activeKeepAlive) {
            setKeepAliveEnabled(true);
            setKeepAliveThreadId(activeKeepAlive.threadId);
            setKeepAliveClient(activeKeepAlive.client);
            setKeepAliveMaxRetries(activeKeepAlive.maxRetries);
            setKeepAliveCooldownMs(activeKeepAlive.cooldownMs);
        } else {
            setKeepAliveEnabled(false);
        }

        // Sync per-thread overrides
        for (const t of allThreads) {
            if (t.keepAlive) {
                setThreadKeepAlive(t.threadId, {
                    enabled: true,
                    client: t.client,
                    maxRetries: t.maxRetries,
                    cooldownMs: t.cooldownMs,
                });
            } else {
                removeThreadKeepAlive(t.threadId);
            }
        }
    } catch {
        // Best-effort sync — don't fail the API call
    }
}
