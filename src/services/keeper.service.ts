import { log } from "../logger.js";
import { findAliveThread, killProcessTree } from "./process.service.js";
import { readThreadHeartbeat } from "../data/file-storage.js";
import { dispatchSpawn } from "./agent-spawn.service.js";
import { getKeepAliveThreads, getThread } from "../data/memory/thread-registry.js";
import type { ThreadLifecycleService } from "./thread-lifecycle.service.js";
import type { AgentType } from "../config.js";
import { errorMessage } from "../utils.js";
import type { initMemoryDb } from "../memory.js";

const KEEPER_CHECK_INTERVAL_MS = 120_000;     // 2 min
const KEEPER_MAX_RETRIES = 5;
const KEEPER_COOLDOWN_MS = 300_000;            // 5 min
const FAST_EXIT_THRESHOLD_MS = 60_000;         // 60s
const FAST_EXIT_MAX_COUNT = 3;
const FAST_EXIT_BASE_COOLDOWN_MS = 600_000;    // 10 min
const FAST_EXIT_MAX_COOLDOWN_MS = 14_400_000;  // 4 hours
const STUCK_THRESHOLD_MS = 1_800_000;          // 30 min

interface KeeperEntry {
  threadId: number;
  retryCount: number;
  fastExitCount: number;
  fastExitEscalation: number;
  lastStartTime: number;
  cooldownUntil: number;
  stopped: boolean;
  checking: boolean;
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

    // 2. Check if thread is running — direct function call, no HTTP
    const aliveThread = findAliveThread(entry.threadId);

    if (aliveThread) {
      // 3. Check if stuck via heartbeat
      const heartbeat = readThreadHeartbeat(entry.threadId);
      if (heartbeat !== null && (now - heartbeat) > STUCK_THRESHOLD_MS) {
        log.warn(`[keeper] Thread ${entry.threadId} is stuck (no heartbeat for ${Math.round((now - heartbeat) / 60000)}m) — killing`);
        killProcessTree(aliveThread.pid, entry.threadId);
        entry.retryCount = 0;
        // Fall through to restart
      } else {
        // Healthy — reset counters
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

    // 6. Restart: re-verify keepAlive before restarting
    const db = this.deps.getMemoryDb();
    const thread = getThread(db, entry.threadId);
    if (!thread || !thread.keepAlive) {
      log.info(`[keeper] Thread ${entry.threadId} no longer has keepAlive=true — will stop at next sync`);
      return;
    }

    log.info(`[keeper] Thread ${entry.threadId} not running — restarting (attempt ${entry.retryCount + 1}/${KEEPER_MAX_RETRIES})`);

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
