/**
 * File-based per-thread message broker.
 *
 * Incoming Telegram messages are written by the poller to per-thread JSONL
 * files under ~/.remote-copilot-mcp/threads/<threadId>.jsonl.
 * Each MCP instance reads from its own thread file — contention-free.
 */

import {
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { log } from "../../logger.js";
import { isPidAlive } from "./lock.js";
import type { Database } from "better-sqlite3";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const BASE_DIR = join(homedir(), ".remote-copilot-mcp");
const THREADS_DIR = join(BASE_DIR, "threads");
export const OFFSET_FILE = join(BASE_DIR, "offset");

// ---------------------------------------------------------------------------
// Lazy DB access for per-thread reaction routing
// ---------------------------------------------------------------------------

let brokerDbGetter: (() => Database) | null = null;

/**
 * Wire up a lazy database accessor so the broker can look up
 * message_id → thread_id in the sent_messages table.
 */
export function setBrokerDb(getter: () => Database): void {
    brokerDbGetter = getter;
}

/**
 * Look up which thread a message belongs to via sent_messages.
 * Returns undefined if the lookup fails or the message isn't tracked.
 */
function lookupThreadForMessage(messageId: number): number | undefined {
    if (!brokerDbGetter) return undefined;
    try {
        const db = brokerDbGetter();
        const row = db.prepare(
            `SELECT thread_id FROM sent_messages WHERE message_id = ?`
        ).get(messageId) as { thread_id: number } | undefined;
        return row?.thread_id;
    } catch {
        return undefined; // non-fatal — fall back to global file
    }
}

// ---------------------------------------------------------------------------
// Reaction file helpers
// ---------------------------------------------------------------------------

export interface StoredReaction {
    emoji: string;
    messageId: number;
    chatId: number;
    date: number;
}

const REACTION_FILE = join(BASE_DIR, "pending_reaction.json");

function reactionFileForThread(threadId: number): string {
    return join(BASE_DIR, `pending_reaction_${threadId}.json`);
}

export function writeReactionFile(reaction: StoredReaction): void {
    try {
        // Try to route the reaction to the correct thread's file
        const threadId = lookupThreadForMessage(reaction.messageId);
        const file = threadId !== undefined
            ? reactionFileForThread(threadId)
            : REACTION_FILE;
        writeFileSync(file, JSON.stringify(reaction), "utf8");
        if (threadId !== undefined) {
            log.info(`[dispatcher] Reaction routed to thread ${threadId}`);
        }
    } catch (err) { log.debug(`[dispatcher] writeReactionFile failed: ${err instanceof Error ? err.message : String(err)}`); }
}

/**
 * Read and clear the pending reaction (if any).
 * When threadId is provided, reads from the per-thread file first,
 * falling back to the global file for backwards compatibility.
 * Returns null if no reaction is pending.
 */
export function readPendingReaction(threadId?: number): StoredReaction | null {
    // Try per-thread file first if threadId is provided
    if (threadId !== undefined) {
        const threadFile = reactionFileForThread(threadId);
        const threadResult = readAndClearReactionFile(threadFile);
        if (threadResult) return threadResult;
    }
    // Fall back to global file
    return readAndClearReactionFile(REACTION_FILE);
}

/**
 * Read and clear a single reaction file. Returns null if not found/corrupt.
 */
function readAndClearReactionFile(filePath: string): StoredReaction | null {
    let raw: string;
    try {
        raw = readFileSync(filePath, "utf8");
    } catch {
        return null; // File doesn't exist — no pending reaction.
    }
    // Delete the file *after* a successful read.  If unlinkSync fails
    // (e.g. another process already consumed it) we still have `raw`
    // and can parse + return the reaction instead of discarding it.
    try { unlinkSync(filePath); } catch { /* already gone — fine */ }
    try {
        return JSON.parse(raw) as StoredReaction;
    } catch {
        return null; // Corrupt JSON — discard.
    }
}

// ---------------------------------------------------------------------------
// Directory setup & orphan recovery
// ---------------------------------------------------------------------------

export function ensureDirs(): void {
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
                        log.info(`[dispatcher] Recovered orphaned file: ${f}`);
                    } catch (err) { log.debug(`[dispatcher] Failed to recover orphaned file ${f}: ${err instanceof Error ? err.message : String(err)}`); }
                }
            }
        }
    } catch (err) { log.debug(`[dispatcher] recoverOrphanedReads scan failed: ${err instanceof Error ? err.message : String(err)}`); }
}

// ---------------------------------------------------------------------------
// Offset persistence (shared across all instances)
// ---------------------------------------------------------------------------

export function readOffset(): number {
    try {
        const raw = readFileSync(OFFSET_FILE, "utf8").trim();
        const n = Number(raw);
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

export function writeOffset(offset: number): void {
    try {
        const tmp = OFFSET_FILE + `.tmp.${process.pid}`;
        writeFileSync(tmp, String(offset), "utf8");
        renameSync(tmp, OFFSET_FILE); // atomic replace
    } catch (err) {
        log.debug(`[dispatcher] writeOffset failed: ${err instanceof Error ? err.message : String(err)}`);
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
        video_note?: {
            file_id: string;
            length: number;
            duration: number;
        };
        sticker?: {
            file_id: string;
            emoji?: string;
            set_name?: string;
        };
        animation?: {
            file_id: string;
            duration?: number;
            thumbnail?: {
                file_id: string;
            };
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
        if (!line.trim()) continue;
        try {
            results.push(JSON.parse(line) as StoredMessage);
        } catch {
            log.warn(`[dispatcher] Skipping corrupt JSONL line in ${label}`);
        }
    }
    return results;
}

/**
 * Append a message to a thread's JSONL file.
 * Throws on write failure so the caller can track which messages were persisted.
 */
export function appendToThread(threadId: number | "general", msg: StoredMessage): void {
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
        const messages = parseJsonlLines(raw, `${key}.jsonl`);
        try { unlinkSync(tmp); } catch { /* already gone */ }
        return messages;
    } catch {
        // Read failed — restore the original file to prevent message loss
        try { renameSync(tmp, file); } catch { /* best effort */ }
        return [];
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
