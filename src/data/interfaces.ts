import type { Database } from "./memory/schema.js";
import type { ThreadRegistryEntry } from "./memory/thread-registry.js";
import type { ScheduledTask } from "../scheduler.js";

export interface IThreadRepository {
  registerThread(
    db: Database,
    entry: {
      threadId: number;
      name: string;
      type: ThreadRegistryEntry["type"];
      rootThreadId?: number;
      badge?: string;
      client?: string;
      maxRetries?: number;
      cooldownMs?: number;
      keepAlive?: boolean;
      dailyRotation?: boolean;
      workingDirectory?: string;
    },
  ): ThreadRegistryEntry;
  updateThread(
    db: Database,
    threadId: number,
    updates: Partial<
      Pick<
        ThreadRegistryEntry,
        | "name"
        | "status"
        | "lastActiveAt"
        | "keepAlive"
        | "dailyRotation"
        | "autonomousMode"
        | "client"
        | "maxRetries"
        | "cooldownMs"
        | "badge"
        | "telegramTopicId"
        | "identityPrompt"
        | "workingDirectory"
      >
    >,
  ): boolean;
  archiveThread(db: Database, threadId: number): boolean;
  getThread(db: Database, threadId: number): ThreadRegistryEntry | null;
  getAllThreads(db: Database): ThreadRegistryEntry[];
  getRootThreads(db: Database): ThreadRegistryEntry[];
}

export interface ISessionRepository {
  getSession(chatId: string, name: string): number | undefined;
  setSession(chatId: string, name: string, threadId: number): void;
  deleteSession(chatId: string, name: string): void;
  lookupTopicRegistry(chatId: string, name: string): number | undefined;
  registerTopicRegistry(chatId: string, name: string, threadId: number): void;
}

export interface IScheduleRepository {
  loadSchedule(threadId: number): ScheduledTask[];
  saveSchedule(threadId: number, tasks: ScheduledTask[]): void;
  deleteSchedule(threadId: number): void;
  listSchedules(threadId: number): ScheduledTask[];
}
