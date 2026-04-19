/**
 * File-lock acquisition and management for the Telegram poller.
 *
 * Only one MCP instance may poll Telegram at a time. This module provides
 * a file-system–based lock (with stale-lock detection via PID check) so
 * multiple instances can coordinate without conflicts.
 */

import {
    existsSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const BASE_DIR = join(homedir(), ".remote-copilot-mcp");
const LOCK_FILE = join(BASE_DIR, "poller.lock");

/**
 * Try to become the poller using exclusive file creation to prevent TOCTOU races.
 * - If no lock file exists → atomically create it (flag: "wx").
 * - If lock file exists but the PID is dead → remove and retry.
 * - If lock file exists, PID is alive, but lock is stale → remove and retry.
 * - Otherwise → someone else is the poller.
 */
const STALE_LOCK_MS = 90 * 1000; // 90 seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether a PID is still alive. */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0); // Signal 0 = existence check, does not kill.
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Lock read / write / remove
// ---------------------------------------------------------------------------

export function readLock(): { pid: number; ts: number } | null {
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
export function refreshLock(): boolean {
    const current = readLock();
    if (!current || current.pid !== process.pid) {
        return false; // Lock missing or owned by someone else.
    }
    try {
        const tmp = LOCK_FILE + ".tmp." + process.pid;
        writeFileSync(
            tmp,
            JSON.stringify({ pid: process.pid, ts: Date.now() }),
            "utf8",
        );
        renameSync(tmp, LOCK_FILE);
        return true;
    } catch {
        return false;
    }
}

export function removeLock(): void {
    try {
        unlinkSync(LOCK_FILE);
    } catch {
        // Already gone.
    }
}

// ---------------------------------------------------------------------------
// Lock acquisition
// ---------------------------------------------------------------------------

/**
 * Try to acquire the poller lock, retrying up to `maxAttempts` times with
 * `delayMs` between attempts. Handles the Windows race where a just-killed
 * process still appears alive briefly to process.kill(pid, 0).
 */
export async function tryAcquireLockWithRetry(
    maxAttempts = 3,
    delayMs = 2000,
): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (tryAcquireLock()) return true;
        if (attempt < maxAttempts) {
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
    }
    return false;
}

export function tryAcquireLock(): boolean {
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
