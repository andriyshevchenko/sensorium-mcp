/**
 * Scheduler for wake-up tasks.
 *
 * Supports two types of scheduled tasks:
 *   - Cron-based: fires at specific times (e.g. "0 9 * * *" = 9am daily)
 *   - Delay-based: fires after N minutes of operator silence  
 *
 * Schedule state is persisted to disk per-thread so tasks survive restarts.
 * The wait_for_instructions polling loop checks for due tasks on each timeout.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "node:crypto";
import { homedir } from "os";
import { join } from "path";
import { log } from "./logger.js";

const SCHEDULES_DIR = join(homedir(), ".remote-copilot-mcp", "schedules");

export interface ScheduledTask {
    /** Unique task ID (auto-generated). */
    id: string;
    /** Thread ID this task is scoped to. */
    threadId: number;
    /** The prompt to inject when the task fires. */
    prompt: string;
    /** Human-readable label for the task. */
    label: string;
    /** When set, task fires after this many minutes of operator silence. */
    afterIdleMinutes?: number;
    /** When set, ISO 8601 timestamp for one-shot scheduled execution. */
    runAt?: string;
    /** When set, cron expression for recurring execution (minute hour day month weekday). */
    cron?: string;
    /** Timestamp of last execution (ISO string), for cron dedup. */
    lastFiredAt?: string;
    /** If true, the task is a one-shot and should be removed after firing. */
    oneShot: boolean;
    /** Creation timestamp (ISO string). */
    createdAt: string;
}

function schedulesFilePath(threadId: number): string {
    return join(SCHEDULES_DIR, `${threadId}.json`);
}

function ensureDir(): void {
    mkdirSync(SCHEDULES_DIR, { recursive: true });
}

function loadSchedules(threadId: number): ScheduledTask[] {
    ensureDir();
    const file = schedulesFilePath(threadId);
    try {
        if (!existsSync(file)) return [];
        const raw = readFileSync(file, "utf8");
        return JSON.parse(raw) as ScheduledTask[];
    } catch {
        return [];
    }
}

function saveSchedules(threadId: number, tasks: ScheduledTask[]): void {
    ensureDir();
    const file = schedulesFilePath(threadId);
    const tmp = file + `.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(tasks, null, 2), "utf8");
    renameSync(tmp, file);
}

export function addSchedule(task: ScheduledTask): void {
    const tasks = loadSchedules(task.threadId);
    tasks.push(task);
    saveSchedules(task.threadId, tasks);
}

export function removeSchedule(threadId: number, taskId: string): boolean {
    const tasks = loadSchedules(threadId);
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return false;
    tasks.splice(idx, 1);
    saveSchedules(threadId, tasks);
    return true;
}

/**
 * Remove all scheduled tasks for a thread.
 * Called when a Telegram topic is deleted.
 */
export function purgeSchedules(threadId: number): void {
    ensureDir();
    const file = schedulesFilePath(threadId);
    try {
        unlinkSync(file);
    } catch {
        // Already gone or never existed.
    }
}

export function listSchedules(threadId: number): ScheduledTask[] {
    return loadSchedules(threadId);
}

/**
 * Generate a unique task ID.
 */
export function generateTaskId(): string {
    return `task_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

/**
 * Parse a simple cron expression (5 fields: minute hour day-of-month month day-of-week).
 * Returns true if the given date matches the cron expression.
 * Supports: *, specific numbers, and comma-separated lists.
 * Does NOT support ranges (1-5) or steps (star/5) for simplicity.
 */
function matchesCronField(field: string, value: number): boolean {
    if (field === "*") return true;
    const parts = field.split(",").map(s => s.trim());
    return parts.some(p => Number(p) === value);
}

function matchesCron(cronExpr: string, date: Date): boolean {
    const fields = cronExpr.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    return (
        matchesCronField(minute, date.getMinutes()) &&
        matchesCronField(hour, date.getHours()) &&
        matchesCronField(dayOfMonth, date.getDate()) &&
        matchesCronField(month, date.getMonth() + 1) &&
        matchesCronField(dayOfWeek, date.getDay())
    );
}

/**
 * Find the most recent minute before `beforeDate` that matches the cron expression.
 * Scans backward minute-by-minute up to 1440 minutes (24 hours).
 * Returns null if no match is found in that window.
 */
function getLastCronMatch(cronExpr: string, beforeDate: Date): Date | null {
    const MAX_LOOKBACK_MINUTES = 1440; // 24 hours
    // Start from one minute before beforeDate (truncated to the minute)
    const start = new Date(beforeDate);
    start.setSeconds(0, 0);
    start.setTime(start.getTime() - 60000); // one minute before

    for (let i = 0; i < MAX_LOOKBACK_MINUTES; i++) {
        const candidate = new Date(start.getTime() - i * 60000);
        if (matchesCron(cronExpr, candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Check for due tasks and return the first one that should fire.
 * 
 * @param threadId - Thread to check schedules for
 * @param lastOperatorMessageAt - Timestamp of last operator message (for idle detection)
 * @param hasNewMessages - Whether operator has sent messages since last check
 * @returns The due task's prompt, or null if nothing is due
 */
export function checkDueTasks(
    threadId: number,
    lastOperatorMessageAt: number,
    hasNewMessages: boolean,
): { prompt: string; task: ScheduledTask } | null {
    const tasks = loadSchedules(threadId);
    if (tasks.length === 0) return null;

    const now = new Date();
    let modified = false;

    let result: { prompt: string; task: ScheduledTask } | null = null;

    for (const task of tasks) {
        // --- One-shot at specific time ---
        if (task.runAt) {
            const runAtDate = new Date(task.runAt);
            if (now >= runAtDate) {
                // If operator has new messages, reschedule by 5 minutes
                if (hasNewMessages) {
                    task.runAt = new Date(now.getTime() + 5 * 60000).toISOString();
                    modified = true;
                    continue;
                }
                task.lastFiredAt = now.toISOString();
                if (task.oneShot) {
                    const idx = tasks.indexOf(task);
                    tasks.splice(idx, 1);
                }
                modified = true;
                result = { prompt: task.prompt, task };
                break;
            }
        }

        // --- Cron-based recurring ---
        if (task.cron) {
            // Normal path: current minute matches the cron pattern
            if (matchesCron(task.cron, now)) {
                // Dedup: don't fire again within the same minute
                if (task.lastFiredAt) {
                    const lastFired = new Date(task.lastFiredAt);
                    if (
                        lastFired.getMinutes() === now.getMinutes() &&
                        lastFired.getHours() === now.getHours() &&
                        lastFired.getDate() === now.getDate() &&
                        lastFired.getMonth() === now.getMonth() &&
                        lastFired.getFullYear() === now.getFullYear()
                    ) {
                        continue; // Already fired this minute
                    }
                }
                if (hasNewMessages) {
                    // Operator is active — skip this fire, it'll try next matching minute
                    continue;
                }
                task.lastFiredAt = now.toISOString();
                modified = true;
                result = { prompt: task.prompt, task };
                break; // Return FIRST due task — others wait for subsequent polls
            }

            // Catch-up path: detect missed cron executions while server was down.
            // Only fires the MOST RECENT missed occurrence (via getLastCronMatch),
            // not every individual missed window. lastFiredAt is set to `now` so
            // the dedup logic prevents re-firing on the next poll.
            const lastMatch = getLastCronMatch(task.cron, now);
            if (lastMatch) {
                const lastFiredTime = task.lastFiredAt
                    ? new Date(task.lastFiredAt).getTime()
                    : 0;
                if (lastFiredTime < lastMatch.getTime()) {
                    if (hasNewMessages) {
                        // Operator is active — skip catch-up
                        continue;
                    }
                    log.info(
                        `[scheduler] Catch-up firing missed cron task: ${task.label} (was due at ${lastMatch.toISOString()})`,
                    );
                    task.lastFiredAt = now.toISOString();
                    modified = true;
                    result = { prompt: task.prompt, task };
                    break; // Return FIRST due task — others wait for subsequent polls
                }
            }
        }

        // --- Idle-based (fire after N minutes of silence) ---
        if (task.afterIdleMinutes != null) {
            const idleMs = now.getTime() - lastOperatorMessageAt;
            const thresholdMs = task.afterIdleMinutes * 60000;
            if (idleMs >= thresholdMs) {
                // Dedup: don't fire again while operator remains idle.
                // Only re-fire if operator spoke AFTER the last fire (i.e.
                // lastFiredAt is before lastOperatorMessageAt, meaning a new
                // idle period has started).
                if (task.lastFiredAt) {
                    const lastFired = new Date(task.lastFiredAt).getTime();
                    if (lastFired > lastOperatorMessageAt) {
                        continue; // Already fired in this idle period
                    }
                }
                if (hasNewMessages) {
                    // Reset — operator just spoke, so idle counter restarts
                    continue;
                }
                task.lastFiredAt = now.toISOString();
                modified = true;
                result = { prompt: task.prompt, task };
                break;
            }
        }
    }

    if (modified) {
        saveSchedules(threadId, tasks);
    }
    return result;
}
