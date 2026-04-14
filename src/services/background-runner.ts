import type { initMemoryDb } from "../memory.js";
import type { TelegramClient } from "../telegram.js";
import { rotateAllDailySessions } from "../daily-session.js";
import { cleanupExpiredWorkers } from "../tools/thread-lifecycle.js";
import { errorMessage } from "../utils.js";

const DAILY_ROTATION_INTERVAL_MS = 5 * 60_000;
const DAILY_ROTATION_HOUR = 4;
const WORKER_CLEANUP_INTERVAL_MS = 5 * 60_000;

interface BackgroundRunnerDeps {
  getMemoryDb: () => ReturnType<typeof initMemoryDb>;
  telegram: TelegramClient;
  chatId: string;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export class BackgroundJobRunner {
  private intervals: ReturnType<typeof setInterval>[] = [];
  private lastDailyRotationKey: string | null = null;

  constructor(private readonly deps: BackgroundRunnerDeps) {}

  start(): void {
    if (this.intervals.length > 0) return;

    void this.runWorkerCleanup();
    void this.runDailyRotationCheck();

    this.intervals.push(setInterval(() => {
      void this.runWorkerCleanup();
    }, WORKER_CLEANUP_INTERVAL_MS));

    this.intervals.push(setInterval(() => {
      void this.runDailyRotationCheck();
    }, DAILY_ROTATION_INTERVAL_MS));
  }

  stop(): void {
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];
  }

  private async runWorkerCleanup(): Promise<void> {
    try {
      const result = await cleanupExpiredWorkers(
        this.deps.getMemoryDb(),
        this.deps.telegram,
        this.deps.chatId,
      );
      if (result.cleaned > 0) {
        this.deps.log.info(`[worker-cleanup] Cleaned ${result.cleaned} expired worker thread(s).`);
      }
      if (result.errors.length > 0) {
        this.deps.log.warn(`[worker-cleanup] Errors: ${result.errors.join("; ")}`);
      }
    } catch (err) {
      this.deps.log.error(`Expired worker cleanup error: ${errorMessage(err)}`);
    }
  }

  private async runDailyRotationCheck(): Promise<void> {
    const now = new Date();
    if (now.getHours() !== DAILY_ROTATION_HOUR || now.getMinutes() >= 5) return;

    const rotationKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    if (this.lastDailyRotationKey === rotationKey) return;
    this.lastDailyRotationKey = rotationKey;

    try {
      this.deps.log.info("Starting daily session rotation...");
      const results = await rotateAllDailySessions();
      for (const result of results) {
        if (result.error) {
          this.deps.log.error(`Daily rotation failed for root ${result.rootThreadId}: ${result.error}`);
        } else {
          this.deps.log.info(`Daily rotation complete for root ${result.rootThreadId}`);
        }
      }
    } catch (err) {
      this.deps.log.error(`Daily rotation error: ${errorMessage(err)}`);
    }
  }
}
