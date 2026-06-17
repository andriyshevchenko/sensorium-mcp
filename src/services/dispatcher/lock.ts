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
    readdirSync,
    unlinkSync,
} from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../logger.js";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const BASE_DIR = join(homedir(), ".remote-copilot-mcp");
const LOCK_FILE = join(BASE_DIR, "poller.lock");
const LOCK_TMP_PREFIX = "poller.lock.tmp.";

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

export async function readLock(): Promise<{ pid: number; ts: number } | null> {
    try {
        const raw = await readFile(LOCK_FILE, "utf8");
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
 * Read the lock for ownership determination, distinguishing a genuine absence
 * or handover from a transient read failure.
 *
 * Unlike {@link readLock}, this does NOT collapse every failure into `null`.
 * On Windows the same antivirus/indexer contention that blocks `rename` can
 * also briefly block the `open`-for-read (sharing violation), and a concurrent
 * writer can produce a torn/corrupt read. Treating those as "lock gone" would
 * trigger an unnecessary step-down — the exact outage this module avoids.
 *
 * - returns the parsed lock when readable,
 * - `"missing"` when the file genuinely does not exist (ENOENT),
 * - `"io-error"` on a transient read error or torn/corrupt parse.
 */
async function readLockForOwnership(): Promise<{ pid: number; ts: number } | "missing" | "io-error"> {
    let raw: string;
    try {
        raw = await readFile(LOCK_FILE, "utf8");
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "io-error";
    }
    try {
        const parsed = JSON.parse(raw) as { pid: number; ts: number };
        if (typeof parsed.pid === "number" && typeof parsed.ts === "number") {
            return parsed;
        }
    } catch {
        // Torn or corrupt read — likely a concurrent writer. Transient.
        return "io-error";
    }
    return "io-error"; // Parseable but malformed — treat as transient, not loss.
}

/**
 * Outcome of a lock-refresh attempt.
 *
 * - `refreshed`: the lock timestamp was successfully updated on disk.
 * - `lost`: the lock is missing or now owned by a different PID — ownership
 *   has genuinely changed, so the caller must step down.
 * - `io-error`: a transient filesystem error (e.g. Windows EPERM/EBUSY from an
 *   antivirus/indexer briefly holding the file) prevented the timestamp update,
 *   but ownership is unchanged. The caller still owns the lock and should keep
 *   running; the next refresh will retry.
 */
export type LockRefreshResult = "refreshed" | "lost" | "io-error";

/** Process-local counter guaranteeing unique temp-file names even within the
 *  same millisecond when concurrent refreshes overlap (periodic refresher vs.
 *  post-poll refresh). */
let tmpSequence = 0;

/**
 * Write (refresh) the lock file, but only if we still own it.
 * Prevents a TOCTOU race where two pollers run simultaneously:
 * if another process stole the lock between our check and write,
 * we must not overwrite their lock.
 *
 * Ownership is defined solely by the PID recorded in the lock file — NOT by
 * the timestamp. A transient inability to update the timestamp therefore does
 * not imply ownership loss, so it is reported as `io-error` (non-fatal) rather
 * than conflated with a genuine handover (`lost`).
 */
export async function refreshLock(): Promise<LockRefreshResult> {
    const current = await readLockForOwnership();
    if (current === "io-error") {
        // Could not reliably read the lock (transient FS contention). Ownership
        // is unchanged from our perspective — do not step down.
        return "io-error";
    }
    if (current === "missing" || current.pid !== process.pid) {
        return "lost"; // Lock genuinely gone or owned by someone else.
    }
    const tmp = LOCK_FILE + `.tmp.${process.pid}.${Date.now()}.${++tmpSequence}`;
    try {
        await writeFile(
            tmp,
            JSON.stringify({ pid: process.pid, ts: Date.now() }),
            "utf8",
        );
    } catch (err) {
        // Could not write the temp file — transient FS issue. We still own the
        // lock in memory, so this is non-fatal. Clean up any partial file.
        log.warn(`[dispatcher-lock] refreshLock temp write failed: ${err}`);
        try { await unlink(tmp); } catch { /* may not exist */ }
        return "io-error";
    }

    // On Windows, rename() can transiently fail with EPERM/EBUSY when an
    // antivirus/indexer briefly holds a handle on the source or target file.
    // These errors are ephemeral, so retry a few times with a short backoff.
    const RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200];
    for (let attempt = 0; ; attempt++) {
        try {
            await rename(tmp, LOCK_FILE);
            return "refreshed";
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            const retriable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
            if (retriable && attempt < RENAME_RETRY_DELAYS_MS.length) {
                await new Promise<void>((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt]));
                continue;
            }
            // Retries exhausted (or a non-retriable FS error). Transient
            // contention does not change ownership, so keep the lock and report
            // a non-fatal I/O error instead of forcing the poller to step down.
            // If the failure persists long enough for the on-disk timestamp to
            // go stale AND another instance exists, that instance will steal the
            // lock; our next refresh then returns `lost` and we step down cleanly.
            log.warn(`[dispatcher-lock] refreshLock rename failed (${code}) after ${attempt} retries: ${err}`);
            try { await unlink(tmp); } catch { /* best-effort cleanup */ }
            return "io-error";
        }
    }
}

export function removeLock(): void {
    try {
        const raw = readFileSync(LOCK_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.pid === process.pid) unlinkSync(LOCK_FILE);
    } catch {
        // Already gone or corrupt.
    }
}

// ---------------------------------------------------------------------------
// Lock acquisition
// ---------------------------------------------------------------------------

/**
 * Remove orphaned `poller.lock.tmp.*` files left behind by a process that
 * crashed between writing the temp file and renaming it over the lock.
 * Only sweeps temps owned by dead PIDs so it never races a live refresh.
 * Runs once per process (idempotent guard).
 */
let tmpSweepDone = false;
function sweepOrphanedLockTmps(): void {
    if (tmpSweepDone) return;
    tmpSweepDone = true;
    try {
        for (const f of readdirSync(BASE_DIR)) {
            if (!f.startsWith(LOCK_TMP_PREFIX)) continue;
            // Name format: poller.lock.tmp.<pid>.<ts>.<seq>
            const pid = Number.parseInt(f.slice(LOCK_TMP_PREFIX.length).split(".")[0], 10);
            if (Number.isFinite(pid) && pid !== process.pid && isPidAlive(pid)) continue;
            try { unlinkSync(join(BASE_DIR, f)); } catch { /* race-ok */ }
        }
    } catch { /* dir missing — nothing to sweep */ }
}

/**
 * Try to acquire the poller lock, retrying up to `maxAttempts` times with
 * `delayMs` between attempts. Handles the Windows race where a just-killed
 * process still appears alive briefly to process.kill(pid, 0).
 */
export async function tryAcquireLockWithRetry(
    maxAttempts = 3,
    delayMs = 2000,
): Promise<boolean> {
    sweepOrphanedLockTmps();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (await tryAcquireLock()) return true;
        if (attempt < maxAttempts) {
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
    }
    return false;
}

export async function tryAcquireLock(): Promise<boolean> {
    const existing = await readLock();
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
        await writeFile(
            LOCK_FILE,
            JSON.stringify({ pid: process.pid, ts: Date.now() }),
            { encoding: "utf8", flag: "wx" },
        );
        return true;
    } catch {
        return false; // Another process won the race.
    }
}
