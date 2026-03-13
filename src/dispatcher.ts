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
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync
} from "fs";
import { homedir } from "os";
import { join } from "path";
import type { TelegramClient } from "./telegram.js";
import { errorMessage } from "./utils.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const BASE_DIR = join(homedir(), ".remote-copilot-mcp");
const THREADS_DIR = join(BASE_DIR, "threads");
const LOCK_FILE = join(BASE_DIR, "poller.lock");
const OFFSET_FILE = join(BASE_DIR, "offset");

function ensureDirs(): void {
    mkdirSync(THREADS_DIR, { recursive: true });
    recoverOrphanedReads();
}

/**
 * On startup, scan for orphaned `.reading.PID` files left by hard-crashed
 * processes and append their content back to the original thread file
 * so those messages aren't permanently lost.
 */
function recoverOrphanedReads(): void {
    try {
        const files = readdirSync(THREADS_DIR);
        for (const f of files) {
            const match = f.match(/^(.+)\.reading\.(\d+)$/);
            if (match) {
                const pid = Number.parseInt(match[2], 10);
                if (!isPidAlive(pid)) {
                    const orphan = join(THREADS_DIR, f);
                    const original = join(THREADS_DIR, match[1]);
                    try {
                        const content = readFileSync(orphan, "utf8");
                        writeFileSync(original, content, { flag: "a", encoding: "utf8" });
                        unlinkSync(orphan);
                        process.stderr.write(
                            `[dispatcher] Recovered orphaned file: ${f}\n`,
                        );
                    } catch { /* best effort */ }
                }
            }
        }
    } catch { /* non-fatal */ }
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

/**
 * Write (refresh) the lock file, but only if we still own it.
 * Prevents a TOCTOU race where two pollers run simultaneously:
 * if another process stole the lock between our check and write,
 * we must not overwrite their lock.
 *
 * Returns true if the lock was refreshed, false if we lost ownership.
 */
function refreshLock(): boolean {
    const current = readLock();
    if (current && current.pid !== process.pid) {
        return false; // Someone else owns the lock now.
    }
    writeFileSync(
        LOCK_FILE,
        JSON.stringify({ pid: process.pid, ts: Date.now() }),
        "utf8",
    );
    return true;
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
 * Try to become the poller using exclusive file creation to prevent TOCTOU races.
 * - If no lock file exists → atomically create it (flag: "wx").
 * - If lock file exists but the PID is dead → remove and retry.
 * - If lock file exists, PID is alive, but lock is stale → remove and retry.
 * - Otherwise → someone else is the poller.
 */
const STALE_LOCK_MS = 90 * 1000; // 90 seconds

function tryAcquireLock(): boolean {
    const existing = readLock();
    if (existing) {
        const alive = isPidAlive(existing.pid);
        const stale = Date.now() - existing.ts > STALE_LOCK_MS;
        if (alive && !stale) {
            return false; // Someone else is actively polling.
        }
        // Dead or stale — remove before attempting exclusive create.
        try { unlinkSync(LOCK_FILE); } catch { /* race-ok */ }
    } else if (existsSync(LOCK_FILE)) {
        // Lock file exists but is corrupt/empty (readLock returned null).
        // Remove it so the exclusive create below can succeed.
        try { unlinkSync(LOCK_FILE); } catch { /* race-ok */ }
    }
    // Atomic exclusive create: fails if another process created first.
    try {
        writeFileSync(
            LOCK_FILE,
            JSON.stringify({ pid: process.pid, ts: Date.now() }),
            { encoding: "utf8", flag: "wx" },
        );
        return true;
    } catch {
        return false; // Another process won the race.
    }
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
        document?: {
            file_id: string;
            file_name?: string;
            mime_type?: string;
        };
        voice?: {
            file_id: string;
            duration: number;
            mime_type?: string;
        };
        date: number;
    };
}

function threadFilePath(threadId: number | "general"): string {
    return join(THREADS_DIR, `${threadId}.jsonl`);
}

/** Parse JSONL content into StoredMessage[], skipping corrupt lines. */
function parseJsonlLines(raw: string, label: string): StoredMessage[] {
    if (!raw) return [];
    const results: StoredMessage[] = [];
    for (const line of raw.split("\n")) {
        try {
            results.push(JSON.parse(line) as StoredMessage);
        } catch {
            process.stderr.write(
                `[dispatcher] Skipping corrupt JSONL line in ${label}\n`,
            );
        }
    }
    return results;
}

/**
 * Append a message to a thread's JSONL file.
 * Throws on write failure so the caller can track which messages were persisted.
 */
function appendToThread(threadId: number | "general", msg: StoredMessage): void {
    const file = threadFilePath(threadId);
    const line = JSON.stringify(msg) + "\n";
    writeFileSync(file, line, { flag: "a", encoding: "utf8" });
}

/**
 * Read and clear all pending messages for a thread.
 * Uses rename for atomic read-and-clear to prevent message loss.
 */
export function readThreadMessages(threadId: number | undefined): StoredMessage[] {
    const key: number | "general" = threadId ?? "general";
    const file = threadFilePath(key);
    const tmp = file + ".reading." + process.pid;
    try {
        renameSync(file, tmp);
    } catch {
        return [];
    }
    try {
        const raw = readFileSync(tmp, "utf8").trim();
        return parseJsonlLines(raw, `${key}.jsonl`);
    } catch {
        return [];
    } finally {
        try { unlinkSync(tmp); } catch { /* already gone */ }
    }
}

/**
 * Non-destructive peek at pending messages for a thread.
 * Unlike readThreadMessages, this does NOT consume the messages — they remain
 * in the thread file for the next readThreadMessages call.
 */
export function peekThreadMessages(threadId: number | undefined): StoredMessage[] {
    const key: number | "general" = threadId ?? "general";
    const file = threadFilePath(key);
    try {
        const raw = readFileSync(file, "utf8").trim();
        return parseJsonlLines(raw, `${key}.jsonl`);
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Poller loop
// ---------------------------------------------------------------------------

let pollerRunning = false;
let pollAbortController: AbortController | undefined;

async function pollOnce(
    telegram: TelegramClient,
    chatId: string,
): Promise<void> {
    if (!refreshLock()) {
        // We lost lock ownership — another process took over. Step down.
        pollerRunning = false;
        return;
    }

    const POLL_TIMEOUT_SECONDS = 10;
    let offset = readOffset();

    // Refresh the lock periodically during long polls / 409 retries
    // to prevent it from going stale (STALE_LOCK_MS = 90 s).
    const lockRefresher = setInterval(() => {
        if (!refreshLock()) {
            pollerRunning = false;
            pollAbortController?.abort();
        }
    }, 15_000);

    try {
        pollAbortController = new AbortController();
        const updates = await telegram.getUpdates(
            offset, POLL_TIMEOUT_SECONDS, pollAbortController.signal,
        );

        // Refresh again after the (potentially 10-second) long poll returns.
        if (!refreshLock()) {
            pollerRunning = false;
            return;
        }

        if (updates.length === 0) return;

        // Track the highest offset for which ALL messages were successfully written.
        let committedOffset = offset;
        let allSucceeded = true;

        for (const u of updates) {
            if (!u.message) {
                // Non-message update — skip but still advance past it.
                committedOffset = u.update_id + 1;
                continue;
            }
            if (String(u.message.chat.id) !== chatId) {
                committedOffset = u.update_id + 1;
                continue;
            }

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
                    document: u.message.document ? {
                        file_id: u.message.document.file_id,
                        file_name: u.message.document.file_name,
                        mime_type: u.message.document.mime_type,
                    } : undefined,
                    voice: u.message.voice ? {
                        file_id: u.message.voice.file_id,
                        duration: u.message.voice.duration,
                        mime_type: u.message.voice.mime_type,
                    } : undefined,
                    date: u.message.date,
                },
            };

            try {
                appendToThread(threadId, stored);
                committedOffset = u.update_id + 1;
            } catch (writeErr) {
                process.stderr.write(
                    `[dispatcher] Failed to write message ${u.update_id} to thread ${threadId}: ${errorMessage(writeErr)
                    }\n`,
                );
                allSucceeded = false;
                break; // Stop processing — don't skip messages.
            }
        }

        // Only advance offset to the last successfully written message.
        if (committedOffset > offset) {
            writeOffset(committedOffset);
        }
        if (!allSucceeded) {
            process.stderr.write(
                "[dispatcher] Partial batch write. Will retry remaining messages on next poll.\n",
            );
        }
    } catch (err) {
        // Ignore abort errors during shutdown.
        if (err instanceof DOMException && err.name === "AbortError") return;
        process.stderr.write(
            `[dispatcher] Poll error: ${errorMessage(err)}\n`,
        );
    } finally {
        clearInterval(lockRefresher);
    }
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
export async function startDispatcher(
    telegram: TelegramClient,
    chatId: string,
): Promise<boolean> {
    ensureDirs();
    const isPoller = tryAcquireLock();
    const CONSUMER_RETRY_MS = 10_000;

    // Shared cleanup + loop helpers.
    let cleanupRegistered = false;
    const registerCleanup = () => {
        if (cleanupRegistered) return;
        cleanupRegistered = true;
        const cleanup = () => {
            pollerRunning = false;
            pollAbortController?.abort();
            removeLock();
        };
        process.on("exit", cleanup);
        process.on("SIGINT", () => { cleanup(); process.exit(0); });
        process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    };

    const installConsumerRetry = () => {
        const timer = setInterval(() => {
            if (tryAcquireLock()) {
                clearInterval(timer);
                process.stderr.write(
                    "[dispatcher] Promoted to poller (previous poller seems inactive).\n",
                );
                pollerRunning = true;
                startLoop();
                registerCleanup();
            }
        }, CONSUMER_RETRY_MS);
        timer.unref();
    };

    const startLoop = () => {
        const loop = async () => {
            while (pollerRunning) {
                const currentLock = readLock();
                if (currentLock && currentLock.pid !== process.pid) {
                    process.stderr.write(
                        `[dispatcher] Lock taken by PID ${currentLock.pid}. Stepping down to consumer.\n`,
                    );
                    pollerRunning = false;
                    installConsumerRetry();
                    break;
                }
                try {
                    await pollOnce(telegram, chatId);
                } catch (err) {
                    process.stderr.write(
                        `[dispatcher] Unexpected poll error: ${errorMessage(err)}\n`,
                    );
                    await new Promise<void>((r) => setTimeout(r, 5000));
                }
                await new Promise<void>((r) => setTimeout(r, 500));
            }
        };
        void loop();
    };

    if (isPoller) {
        process.stderr.write("[dispatcher] This instance is the poller.\n");

        // On first run with no offset file, skip all old updates in one call
        // by fetching the latest update_id and setting the offset past it.
        // Awaited so the poll loop never sees offset=0.
        if (!existsSync(OFFSET_FILE)) {
            process.stderr.write(
                "[dispatcher] No offset file. Skipping old updates...\n",
            );
            try {
                // Use a short timeout to prevent blocking startup if another
                // poller is active (409 retry loop could stall for 60+ seconds).
                const drainAbort = new AbortController();
                const drainTimeout = setTimeout(() => drainAbort.abort(), 10_000);
                const latest = await telegram.getUpdates(-1, 0, drainAbort.signal);
                clearTimeout(drainTimeout);
                if (latest.length > 0) {
                    const skipTo = latest[latest.length - 1].update_id + 1;
                    writeOffset(skipTo);
                    process.stderr.write(
                        `[dispatcher] Skipped to offset ${skipTo}.\n`,
                    );
                } else {
                    writeOffset(0);
                }
            } catch (err) {
                // Don't write offset=0 — leave it at whatever the current value is.
                // If the file still doesn't exist, readOffset() returns 0 which is
                // acceptable because the drain simply failed to optimise.
                process.stderr.write(
                    `[dispatcher] Warning: drain failed: ${errorMessage(err)
                    }. Poll loop will start from offset 0.\n`,
                );
            }
        }

        pollerRunning = true;
        startLoop();
        registerCleanup();
    } else {
        process.stderr.write(
            "[dispatcher] Another instance is the poller. This instance is a consumer only.\n",
        );

        // Periodically try to become the poller in case the current one dies
        // but its PID remains alive (zombie process, stuck socket, etc.).
        installConsumerRetry();
    }

    return isPoller;
}

/**
 * Stop the poller loop (if this instance is the poller).
 */
export function stopDispatcher(): void {
    pollerRunning = false;
    removeLock();
}
