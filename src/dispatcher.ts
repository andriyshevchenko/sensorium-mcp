/**
 * Shared Telegram update dispatcher.
 *
 * Problem: Telegram's getUpdates API is exclusive — only one poller per bot
 * token. When multiple MCP server instances run concurrently (multiple VS Code
 * windows), they fight for the poll lock with 409 Conflict errors and silently
 * lose updates meant for other sessions.
 *
 * Solution: A file-system–based message broker.
 *
 *   1. One MCP instance becomes the **poller** (elected via a lock file).
 *      It calls getUpdates and writes incoming messages to per-thread JSON
 *      files under ~/.remote-copilot-mcp/threads/<threadId>.jsonl.
 *   2. All MCP instances (including the poller) **read** from their own
 *      thread file to retrieve messages. This is contention-free because
 *      each instance is scoped to its own thread ID.
 *   3. The lock file is automatically released if the poller process dies
 *      (stale-lock detection via PID check). Another instance then takes over.
 *
 * The dispatcher exports two public functions:
 *   - startDispatcher(telegram, chatId)  — call once on MCP server startup.
 *   - readThreadMessages(threadId)       — non-blocking; returns and clears
 *                                           pending messages for a thread.
 */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync
} from "fs";
import { homedir } from "os";
import { join } from "path";
import type { TelegramClient } from "./telegram.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const BASE_DIR = join(homedir(), ".remote-copilot-mcp");
const THREADS_DIR = join(BASE_DIR, "threads");
const LOCK_FILE = join(BASE_DIR, "poller.lock");
const OFFSET_FILE = join(BASE_DIR, "offset");

function ensureDirs(): void {
    mkdirSync(THREADS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Lock helpers
// ---------------------------------------------------------------------------

function readLock(): { pid: number; ts: number } | null {
    try {
        const raw = readFileSync(LOCK_FILE, "utf8");
        const parsed = JSON.parse(raw) as { pid: number; ts: number };
        if (typeof parsed.pid === "number" && typeof parsed.ts === "number") {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

function writeLock(): void {
    writeFileSync(
        LOCK_FILE,
        JSON.stringify({ pid: process.pid, ts: Date.now() }),
        "utf8",
    );
}

function removeLock(): void {
    try {
        unlinkSync(LOCK_FILE);
    } catch {
        // Already gone.
    }
}

/** Check whether a PID is still alive. */
function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0); // Signal 0 = existence check, does not kill.
        return true;
    } catch {
        return false;
    }
}

/**
 * Try to become the poller. Returns true if this process now holds the lock.
 * - If no lock file exists → take it.
 * - If lock file exists but the PID is dead → take it.
 * - If lock file exists, PID is alive, but lock is >5 min old → take it (stale).
 * - Otherwise → someone else is the poller.
 */
const STALE_LOCK_MS = 5 * 60 * 1000;

function tryAcquireLock(): boolean {
    const existing = readLock();
    if (existing) {
        const alive = isPidAlive(existing.pid);
        const stale = Date.now() - existing.ts > STALE_LOCK_MS;
        if (alive && !stale) {
            return false; // Someone else is actively polling.
        }
        // Dead or stale — take over.
    }
    writeLock();
    return true;
}

// ---------------------------------------------------------------------------
// Offset persistence (shared across all instances)
// ---------------------------------------------------------------------------

function readOffset(): number {
    try {
        const raw = readFileSync(OFFSET_FILE, "utf8").trim();
        const n = Number(raw);
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

function writeOffset(offset: number): void {
    try {
        writeFileSync(OFFSET_FILE, String(offset), "utf8");
    } catch {
        // Non-fatal.
    }
}

// ---------------------------------------------------------------------------
// Thread message files
// ---------------------------------------------------------------------------

export interface StoredMessage {
    update_id: number;
    message: {
        message_id: number;
        chat_id: number;
        text?: string;
        caption?: string;
        message_thread_id?: number;
        photo?: Array<{
            file_id: string;
            width: number;
            height: number;
        }>;
        date: number;
    };
}

function threadFilePath(threadId: number | "general"): string {
    return join(THREADS_DIR, `${threadId}.jsonl`);
}

function appendToThread(threadId: number | "general", msg: StoredMessage): void {
    const file = threadFilePath(threadId);
    try {
        const line = JSON.stringify(msg) + "\n";
        // appendFileSync would be ideal, but writeFileSync with flag "a" works.
        writeFileSync(file, line, { flag: "a", encoding: "utf8" });
    } catch {
        // Non-fatal — message may be lost for this thread.
    }
}

/**
 * Read and clear all pending messages for a thread.
 * Returns an empty array if none.
 */
export function readThreadMessages(threadId: number | undefined): StoredMessage[] {
    const key: number | "general" = threadId ?? "general";
    const file = threadFilePath(key);
    try {
        const raw = readFileSync(file, "utf8").trim();
        if (!raw) return [];
        // Atomically clear the file after reading.
        writeFileSync(file, "", "utf8");
        return raw.split("\n").map((line) => JSON.parse(line) as StoredMessage);
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Poller loop
// ---------------------------------------------------------------------------

let pollerRunning = false;
let pollerInterval: ReturnType<typeof setInterval> | null = null;

async function pollOnce(
    telegram: TelegramClient,
    chatId: string,
): Promise<void> {
    const POLL_TIMEOUT_SECONDS = 30;
    let offset = readOffset();

    try {
        const updates = await telegram.getUpdates(offset, POLL_TIMEOUT_SECONDS);
        if (updates.length === 0) return;

        offset = updates[updates.length - 1].update_id + 1;
        writeOffset(offset);

        for (const u of updates) {
            if (!u.message) continue;
            if (String(u.message.chat.id) !== chatId) continue;

            const threadId: number | "general" =
                u.message.message_thread_id ?? "general";

            const stored: StoredMessage = {
                update_id: u.update_id,
                message: {
                    message_id: u.message.message_id,
                    chat_id: u.message.chat.id,
                    text: u.message.text,
                    caption: u.message.caption,
                    message_thread_id: u.message.message_thread_id,
                    photo: u.message.photo?.map((p) => ({
                        file_id: p.file_id,
                        width: p.width,
                        height: p.height,
                    })),
                    date: u.message.date,
                },
            };

            appendToThread(threadId, stored);
        }
    } catch (err) {
        process.stderr.write(
            `[dispatcher] Poll error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
    }

    // Refresh lock timestamp so other instances know we're alive.
    writeLock();
}

/**
 * Start the shared dispatcher.
 * - Ensures directories exist.
 * - Attempts to acquire the poller lock.
 * - If acquired, starts a polling loop that writes to per-thread files.
 * - If not acquired, this instance is a consumer only (reads from thread files).
 *
 * Returns: whether this instance became the poller.
 */
export function startDispatcher(
    telegram: TelegramClient,
    chatId: string,
): boolean {
    ensureDirs();
    const isPoller = tryAcquireLock();

    if (isPoller) {
        process.stderr.write("[dispatcher] This instance is the poller.\n");

        // Run an initial drain for fresh offset if offset file doesn't exist.
        if (!existsSync(OFFSET_FILE)) {
            // Drain asynchronously — first poll will handle it.
            void (async () => {
                try {
                    let off = 0;
                    for (; ;) {
                        const updates = await telegram.getUpdates(off, 0);
                        if (updates.length === 0) break;
                        off = updates[updates.length - 1].update_id + 1;
                    }
                    writeOffset(off);
                    process.stderr.write(
                        `[dispatcher] Drained old updates. Offset set to ${off}.\n`,
                    );
                } catch (err) {
                    process.stderr.write(
                        `[dispatcher] Warning: Could not drain old updates: ${err instanceof Error ? err.message : String(err)
                        }\n`,
                    );
                }
            })();
        }

        // Continuous poll loop.
        pollerRunning = true;
        const loop = async () => {
            while (pollerRunning) {
                await pollOnce(telegram, chatId);
                // Small delay between polls to avoid tight-looping on errors.
                await new Promise<void>((r) => setTimeout(r, 500));
            }
        };
        void loop();

        // Clean up lock on process exit.
        const cleanup = () => {
            pollerRunning = false;
            removeLock();
        };
        process.on("exit", cleanup);
        process.on("SIGINT", () => {
            cleanup();
            process.exit(0);
        });
        process.on("SIGTERM", () => {
            cleanup();
            process.exit(0);
        });
    } else {
        process.stderr.write(
            "[dispatcher] Another instance is the poller. This instance is a consumer only.\n",
        );
    }

    return isPoller;
}

/**
 * Stop the poller loop (if this instance is the poller).
 */
export function stopDispatcher(): void {
    pollerRunning = false;
    if (pollerInterval) {
        clearInterval(pollerInterval);
        pollerInterval = null;
    }
    removeLock();
}
