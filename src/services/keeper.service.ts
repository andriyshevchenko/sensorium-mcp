import { log } from "../logger.js";
import { findAliveThreadViaPidFile, isProcessAlive, killProcessTree } from "./process.service.js";
import { readThreadHeartbeat } from "../data/file-storage.js";
import { dispatchSpawn } from "./agent-spawn.service.js";
import { getKeepAliveThreads, getThread } from "../data/memory/thread-registry.js";
import { ThreadState, type ThreadLifecycleService } from "./thread-lifecycle.service.js";
import type { AgentType } from "../config.js";
import { errorMessage } from "../utils.js";
import type { initMemoryDb } from "../memory.js";

const KEEPER_CHECK_INTERVAL_MS = 120_000;     // 2 min
const KEEPER_MAX_RETRIES = 5;
const KEEPER_COOLDOWN_MS = 300_000;            // 5 min
const FAST_EXIT_THRESHOLD_MS = 300_000;         // 5 min (covers Claude's internal API retry cycle)
const FAST_EXIT_MAX_COUNT = 3;
const FAST_EXIT_BASE_COOLDOWN_MS = 600_000;    // 10 min
const FAST_EXIT_MAX_COOLDOWN_MS = 14_400_000;  // 4 hours
const STUCK_THRESHOLD_MS = 1_800_000;          // 30 min
const SURVIVED_KILL_MAX = 3;                    // consecutive failed kills before escalating
const SURVIVED_KILL_COOLDOWN_MS = 600_000;     // 10 min — back off after escalating an unkillable process

interface KeeperEntry {
  threadId: number;
  retryCount: number;
  fastExitCount: number;
  fastExitEscalation: number;
  lastStartTime: number;
  cooldownUntil: number;
  stopped: boolean;
  checking: boolean;
  /** True while we are skipping restart because a live untracked worker is
   *  serving the thread (fresh heartbeat, dead tracked PID). Used to log the
   *  warning once per episode instead of every keeper cycle. */
  limboWarned: boolean;
  /** Consecutive cycles where a stuck process survived killProcessTree. Drives
   *  escalation (operator notification) so a truly unkillable process does not
   *  loop silently forever. Reset when a kill finally succeeds. */
  survivedKillCount: number;
}

export class KeeperService {
  private keepers = new Map<number, KeeperEntry>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: {
    getMemoryDb: () => ReturnType<typeof initMemoryDb>;
    threadLifecycle: ThreadLifecycleService;
    telegram: { sendMessage(chatId: string, text: string, parseMode?: string, threadId?: number): Promise<void> };
    chatId: string;
  }) {}

  start(): void {
    if (this.syncTimer !== null) return;
    this.syncKeepers();
    this.syncTimer = setInterval(() => this.syncKeepers(), KEEPER_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    for (const entry of this.keepers.values()) {
      entry.stopped = true;
    }
    this.keepers.clear();
  }

  private syncKeepers(): void {
    // Log memory usage every sync cycle (~2 min) to detect leaks
    const mem = process.memoryUsage();
    log.telemetry(`rss=${Math.round(mem.rss / 1048576)}MB heap=${Math.round(mem.heapUsed / 1048576)}/${Math.round(mem.heapTotal / 1048576)}MB external=${Math.round(mem.external / 1048576)}MB`);

    let threads: ReturnType<typeof getKeepAliveThreads>;
    try {
      const db = this.deps.getMemoryDb();
      threads = getKeepAliveThreads(db);
    } catch (err) {
      log.warn(`[keeper] Failed to fetch keepAlive threads: ${errorMessage(err)}`);
      return;
    }

    const wanted = new Set(threads.map((t) => t.threadId));

    // Remove keepers no longer in the keepAlive list
    for (const [threadId, entry] of this.keepers.entries()) {
      if (!wanted.has(threadId)) {
        entry.stopped = true;
        this.keepers.delete(threadId);
        log.info(`[keeper] Stopped keeper for removed thread ${threadId}`);
      }
    }

    // Add new keepers
    for (const thread of threads) {
      if (!this.keepers.has(thread.threadId)) {
        this.keepers.set(thread.threadId, {
          threadId: thread.threadId,
          retryCount: 0,
          fastExitCount: 0,
          fastExitEscalation: 0,
          lastStartTime: 0,
          cooldownUntil: 0,
          stopped: false,
          checking: false,
          limboWarned: false,
          survivedKillCount: 0,
        });
        log.info(`[keeper] Started keeper for thread ${thread.threadId} ('${thread.name}')`);
      }
    }

    // Check all active keepers (skip if already in-flight to prevent duplicate spawns)
    for (const entry of this.keepers.values()) {
      if (!entry.stopped && !entry.checking) {
        entry.checking = true;
        this.checkAndRestart(entry)
          .catch((err) => {
            log.warn(`[keeper] checkAndRestart error for thread ${entry.threadId}: ${errorMessage(err)}`);
          })
          .finally(() => { entry.checking = false; });
      }
    }
  }

  private async checkAndRestart(entry: KeeperEntry): Promise<void> {
    const now = Date.now();

    // 1. Check cooldown
    if (entry.cooldownUntil > now) {
      log.debug(`[keeper] Thread ${entry.threadId} in cooldown for ${Math.round((entry.cooldownUntil - now) / 1000)}s`);
      return;
    }

    // 2. Check if thread is running — reads PID file directly (authoritative OS evidence)
    const alivePid = findAliveThreadViaPidFile(entry.threadId);

    // 2a. PID file shows no live tracked process — but a fresh heartbeat is the
    // authoritative "someone is actively serving this thread" signal: the poll
    // loop rewrites it every ~2s (and every tool call). If it is fresh, a live
    // Claude worker is STILL serving the thread under a PID we failed to track
    // (e.g. on Windows a process-tree/launcher death leaves the real worker
    // running while the tracked PID is gone). Spawning now would create a
    // DUPLICATE process → the operator gets answered twice. Skip the restart;
    // when the real worker finally exits, its heartbeat goes stale and the
    // normal restart path takes over.
    if (alivePid === undefined) {
      const heartbeat = readThreadHeartbeat(entry.threadId);
      if (heartbeat !== null && (now - heartbeat) < STUCK_THRESHOLD_MS) {
        if (!entry.limboWarned) {
          log.warn(
            `[keeper] Thread ${entry.threadId}: no live tracked PID but heartbeat is fresh (${Math.round((now - heartbeat) / 1000)}s ago) — a live worker is still serving it under an untracked PID. Skipping restart to avoid a duplicate process.`,
          );
          entry.limboWarned = true;
        } else {
          log.debug(`[keeper] Thread ${entry.threadId}: still in untracked-live-worker limbo (heartbeat ${Math.round((now - heartbeat) / 1000)}s ago) — skipping restart.`);
        }
        return;
      }
      // Process is genuinely gone — any prior survived-kill episode is over.
      entry.survivedKillCount = 0;
    }
    // Not in limbo (PID alive, or heartbeat stale/absent) — clear the flag so a
    // future episode logs afresh.
    entry.limboWarned = false;

    if (alivePid !== undefined) {
      // 3. Check if stuck via heartbeat
      const heartbeat = readThreadHeartbeat(entry.threadId);
      const isStuck = heartbeat !== null
        ? (now - heartbeat) > STUCK_THRESHOLD_MS
        // No parseable heartbeat but process is alive — treat as stuck unless
        // freshly spawned by THIS keeper instance (lastStartTime within threshold).
        // Covers zombie processes with empty/corrupt heartbeat files that survived
        // a server restart.
        : entry.lastStartTime > 0
          ? (now - entry.lastStartTime) > STUCK_THRESHOLD_MS
          // Restored from PID file (lastStartTime=0): no heartbeat data at all
          // means the process never wrote one — definitely stuck.
          : true;

      if (isStuck) {
        const reason = heartbeat !== null
          ? `no heartbeat for ${Math.round((now - heartbeat) / 60000)}m`
          : `no valid heartbeat (zombie process)`;
        log.warn(`[keeper] Thread ${entry.threadId} is stuck (${reason}) — killing`);
        try {
          const stuckDb = this.deps.getMemoryDb();
          // Only transition if not already Stuck — Stuck->Stuck is an invalid
          // transition and would throw every cycle while a kill keeps failing.
          if (this.deps.threadLifecycle.getThreadState(stuckDb, entry.threadId) !== ThreadState.Stuck) {
            this.deps.threadLifecycle.transitionThread(stuckDb, entry.threadId, ThreadState.Stuck);
          }
        } catch (err) {
          log.warn(`[keeper] Active→Stuck transition failed for ${entry.threadId}: ${errorMessage(err)}`);
        }
        await killProcessTree(alivePid, entry.threadId);

        // Verify kill succeeded before restarting — if the process is still alive,
        // do NOT spawn a second instance. Keeper will retry on the next cycle.
        if (isProcessAlive(alivePid)) {
          entry.survivedKillCount++;
          log.warn(`[keeper] Thread ${entry.threadId} PID=${alivePid} survived kill (${entry.survivedKillCount}x) — skipping restart (will retry next cycle)`);
          // Escalate: a process that repeatedly refuses to die needs operator
          // attention. Without this the keeper would loop here forever, silently,
          // and the thread would stay dead (this is exactly what happened to 1327).
          if (entry.survivedKillCount >= SURVIVED_KILL_MAX) {
            entry.cooldownUntil = now + SURVIVED_KILL_COOLDOWN_MS;
            log.error(`[keeper] Thread ${entry.threadId} PID=${alivePid} is UNKILLABLE after ${entry.survivedKillCount} attempts — operator intervention required (manual kill). Backing off ${Math.round(SURVIVED_KILL_COOLDOWN_MS / 60000)}m.`);
            await this.notifyDeath(entry.threadId, `process PID=${alivePid} is stuck and won't terminate — needs a manual kill`, SURVIVED_KILL_COOLDOWN_MS);
            entry.survivedKillCount = 0;
          }
          return;
        }

        // Kill succeeded — clear the escalation counter and fall through to restart.
        entry.survivedKillCount = 0;
        entry.retryCount = 0;
        // Fall through to restart
      } else {
        // Healthy — reset counters
        entry.survivedKillCount = 0;
        if (entry.retryCount > 0) {
          log.info(`[keeper] Thread ${entry.threadId} is healthy again (was at retry ${entry.retryCount})`);
        } else {
          log.debug(`[keeper] Thread ${entry.threadId} is healthy`);
        }
        entry.retryCount = 0;
        entry.fastExitCount = 0;
        entry.fastExitEscalation = 0;
        return;
      }
    }

    // Thread is not running (or was stuck and killed)

    // 4. Fast-exit detection
    if (entry.lastStartTime > 0 && (now - entry.lastStartTime) < FAST_EXIT_THRESHOLD_MS) {
      entry.fastExitCount++;
      if (entry.fastExitCount >= FAST_EXIT_MAX_COUNT) {
        const cooldown = Math.min(
          FAST_EXIT_BASE_COOLDOWN_MS * Math.pow(2, entry.fastExitEscalation),
          FAST_EXIT_MAX_COOLDOWN_MS,
        );
        entry.cooldownUntil = now + cooldown;
        entry.fastExitEscalation++;
        log.warn(`[keeper] Thread ${entry.threadId}: ${entry.fastExitCount} consecutive fast exits — backing off ${Math.round(cooldown / 60000)}m`);
        await this.notifyDeath(entry.threadId, "repeated fast exits — check credits/API key", cooldown);
        entry.fastExitCount = 0;
        entry.retryCount = 0;
        return;
      }
    } else if (entry.lastStartTime > 0) {
      // Previous start was long ago — not a fast exit pattern
      entry.fastExitCount = 0;
      entry.fastExitEscalation = 0;
    }

    // 5. Max retries check
    if (entry.retryCount >= KEEPER_MAX_RETRIES) {
      entry.cooldownUntil = now + KEEPER_COOLDOWN_MS;
      log.warn(`[keeper] Thread ${entry.threadId}: max retries (${KEEPER_MAX_RETRIES}) exceeded — cooling down for ${KEEPER_COOLDOWN_MS / 60000}m`);
      await this.notifyDeath(entry.threadId, "max retries exceeded", KEEPER_COOLDOWN_MS);
      entry.retryCount = 0;
      entry.fastExitCount = 0;
      return;
    }

    // 6. Restart: re-check stopped (may have been set by syncKeepers while in-flight)
    if (entry.stopped) return;

    // Re-verify keepAlive before restarting
    const db = this.deps.getMemoryDb();
    const thread = getThread(db, entry.threadId);
    if (!thread || !thread.keepAlive) {
      log.info(`[keeper] Thread ${entry.threadId} no longer has keepAlive=true — will stop at next sync`);
      return;
    }

    const lastStartLabel = entry.lastStartTime > 0
      ? `last keeper-start ${Math.round((now - entry.lastStartTime) / 1000)}s ago`
      : "never started by this server (inherited PID file)";
    log.info(`[keeper] Thread ${entry.threadId} not running — restarting (attempt ${entry.retryCount + 1}/${KEEPER_MAX_RETRIES}, ${lastStartLabel})`);

    const result = dispatchSpawn(
      (thread.client || "claude") as AgentType,
      thread.name,
      entry.threadId,
      this.deps.threadLifecycle,
      thread.workingDirectory ?? undefined,
    );

    if ("pid" in result) {
      entry.lastStartTime = Date.now();
      entry.retryCount = 0;
      log.info(`[keeper] Thread ${entry.threadId} restarted successfully (PID=${result.pid})`);
      try { this.deps.threadLifecycle.activateThread(db, entry.threadId); } catch (err) { log.warn(`[keeper] activateThread failed for ${entry.threadId}: ${errorMessage(err)}`); }
    } else {
      entry.retryCount++;
      log.warn(`[keeper] Thread ${entry.threadId} restart failed (attempt ${entry.retryCount}/${KEEPER_MAX_RETRIES}): ${result.error}`);
    }
  }

  private async notifyDeath(threadId: number, reason: string, cooldownMs?: number): Promise<void> {
    try {
      const db = this.deps.getMemoryDb();
      const thread = getThread(db, threadId);
      const name = thread?.name ?? `Thread ${threadId}`;
      const suffix = cooldownMs ? `cooling down for ${Math.round(cooldownMs / 60000)}m` : "will retry";
      await this.deps.telegram.sendMessage(
        this.deps.chatId,
        `💀 <b>${name}</b> session died (${reason}) — ${suffix}`,
        "HTML",
        threadId,
      );
    } catch (err) {
      log.warn(`[keeper] notifyDeath failed for thread ${threadId}: ${errorMessage(err)}`);
    }
  }
}
