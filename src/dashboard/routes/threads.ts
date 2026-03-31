/**
 * Dashboard API — thread registry route handlers.
 * Covers: listing, creating, updating, archiving, and deleting threads.
 */

import {
    registerThread,
    getThread,
    getRootThreads,
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
    type KeeperClient,
} from "../../config.js";

import { readBody, safeParseJSON, type RouteHandler, type RouteArgs } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_STATUSES = ["active", "archived", "expired"] as const;

/** Extract valid update fields from a request body. Returns an error string on validation failure. */
function buildThreadUpdates(
    body: Record<string, unknown>,
): Partial<Pick<ThreadRegistryEntry, "name" | "status" | "keepAlive" | "client" | "maxRetries" | "cooldownMs" | "badge">> | string {
    const updates: Partial<Pick<ThreadRegistryEntry, "name" | "status" | "keepAlive" | "client" | "maxRetries" | "cooldownMs" | "badge">> = {};
    if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
    if (typeof body.status === "string") {
        if (!(VALID_STATUSES as readonly string[]).includes(body.status)) {
            return `status must be one of: ${VALID_STATUSES.join(", ")}`;
        }
        updates.status = body.status as ThreadRegistryEntry["status"];
    }
    if (typeof body.keepAlive === "boolean") updates.keepAlive = body.keepAlive;
    if (typeof body.client === "string") updates.client = body.client;
    if (typeof body.maxRetries === "number") updates.maxRetries = body.maxRetries;
    if (typeof body.cooldownMs === "number") updates.cooldownMs = body.cooldownMs;
    if (typeof body.badge === "string") updates.badge = body.badge;
    return updates;
}

// ─── GET /api/threads — list all active threads grouped ─────────────────────

export const handleGetThreads: RouteHandler = ({ json, db }) => {
    const threads = getActiveThreads(db);
    const roots = threads.filter(t => t.type === "root");
    const grouped = roots.map(root => ({
        ...root,
        children: threads.filter(t => t.rootThreadId === root.threadId && t.type !== "root"),
    }));
    const orphans = threads.filter(
        t => t.type !== "root" && !threads.some(r => r.type === "root" && r.threadId === t.rootThreadId),
    );
    json({ threads: grouped, orphans });
    return true;
};

// ─── GET /api/threads/roots — list root threads only ────────────────────────

export const handleGetRootThreads: RouteHandler = ({ json, db }) => {
    json({ threads: getRootThreads(db) });
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
            if (typeof threadId !== "number" || !Number.isFinite(threadId) || threadId <= 0) {
                json({ error: "threadId must be a positive number" }, 400);
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
                client: typeof body.client === "string" ? body.client : undefined,
                keepAlive: typeof body.keepAlive === "boolean" ? body.keepAlive : undefined,
            });

            json(entry, 201);

            // Sync keepAlive to settings.json for watcher backward compatibility
            if (entry.keepAlive) {
                syncKeepAliveToSettings(db);
            }
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
            if ("keepAlive" in updates || "client" in updates) {
                syncKeepAliveToSettings(db);
            }
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
    return true;
}

// ─── Settings.json sync for watcher backward compatibility ──────────────────

/**
 * Sync thread_registry keepAlive settings to settings.json for watcher backward compatibility.
 * The watcher's readKeeperSettingsFromFile() reads settings.json during startup before the MCP server is ready.
 */
function syncKeepAliveToSettings(db: Database): void {
    try {
        const roots = getRootThreads(db);
        const activeKeepAlive = roots.find(r => r.keepAlive);

        if (activeKeepAlive) {
            setKeepAliveEnabled(true);
            setKeepAliveThreadId(activeKeepAlive.threadId);
            setKeepAliveClient(activeKeepAlive.client as KeeperClient);
            setKeepAliveMaxRetries(activeKeepAlive.maxRetries);
            setKeepAliveCooldownMs(activeKeepAlive.cooldownMs);
        } else {
            setKeepAliveEnabled(false);
        }

        // Sync per-thread overrides
        for (const root of roots) {
            if (root.keepAlive) {
                setThreadKeepAlive(root.threadId, {
                    enabled: true,
                    client: root.client as KeeperClient,
                    maxRetries: root.maxRetries,
                    cooldownMs: root.cooldownMs,
                });
            } else {
                removeThreadKeepAlive(root.threadId);
            }
        }
    } catch {
        // Best-effort sync — don't fail the API call
    }
}
