import type { Database } from "../data/memory/schema.js";
import type { IThreadRepository, ISessionRepository } from "../data/interfaces.js";
import type { ThreadRegistryEntry } from "../data/memory/thread-registry.js";

export enum ThreadState {
  Active = "active",
  Dormant = "dormant",
  Exited = "exited",
  Archived = "archived",
  Expired = "expired",
}

type PersistedThreadState = ThreadRegistryEntry["status"];

type RegisterThreadInput = Parameters<IThreadRepository["registerThread"]>[1] & {
  chatId?: string;
  aliases?: string[];
  telegramTopicId?: number | null;
};

type ActivateThreadInput = Partial<
  Pick<
    ThreadRegistryEntry,
    "client" | "keepAlive" | "lastActiveAt" | "telegramTopicId" | "workingDirectory"
  >
>;

type RemapTopicInput = {
  threadId: number;
  chatId: string;
  topicName: string;
  telegramTopicId: number;
  aliases?: string[];
};

export interface ThreadLifecycleTelegramGateway {
  sendMessage(chatId: string, text: string, parseMode?: string, threadId?: number): Promise<unknown>;
}

export interface ThreadLifecycleLogger {
  info(message: string): void;
  warn(message: string): void;
}

const VALID_TRANSITIONS: Record<ThreadState, ReadonlySet<ThreadState>> = {
  [ThreadState.Active]: new Set([ThreadState.Active, ThreadState.Dormant, ThreadState.Exited, ThreadState.Archived, ThreadState.Expired]),
  [ThreadState.Dormant]: new Set([ThreadState.Active, ThreadState.Archived, ThreadState.Expired]),
  [ThreadState.Exited]: new Set([ThreadState.Active, ThreadState.Archived, ThreadState.Expired]),
  [ThreadState.Archived]: new Set(),
  [ThreadState.Expired]: new Set([ThreadState.Archived]),
};

export class ThreadLifecycleService {
  constructor(
    private readonly threadRepository: IThreadRepository,
    private readonly sessionRepository: ISessionRepository,
    private readonly telegramGateway: ThreadLifecycleTelegramGateway,
    private readonly logger: ThreadLifecycleLogger,
  ) {}

  registerThread(db: Database, entry: RegisterThreadInput): ThreadRegistryEntry {
    const current = this.threadRepository.getThread(db, entry.threadId);
    this.assertTransition(current?.status, ThreadState.Active, "registerThread");

    this.threadRepository.registerThread(db, entry);
    if (entry.telegramTopicId !== undefined) {
      this.threadRepository.updateThread(db, entry.threadId, { telegramTopicId: entry.telegramTopicId });
    }

    this.syncTopicMappings(entry.chatId, entry.name, entry.threadId, entry.aliases);
    const updated = this.threadRepository.getThread(db, entry.threadId);
    if (!updated) {
      throw new Error(`registerThread: failed to load thread ${entry.threadId} after registration`);
    }

    this.logger.info(`[thread-lifecycle] registerThread -> active (${entry.threadId})`);
    return updated;
  }

  activateThread(db: Database, threadId: number, updates: ActivateThreadInput = {}): ThreadRegistryEntry {
    const current = this.requireThread(db, threadId, "activateThread");
    this.assertTransition(current.status, ThreadState.Active, "activateThread");

    this.threadRepository.updateThread(db, threadId, {
      ...updates,
      status: ThreadState.Active,
      lastActiveAt: updates.lastActiveAt ?? new Date().toISOString(),
    });

    const updated = this.requireThread(db, threadId, "activateThread");
    this.logger.info(`[thread-lifecycle] activateThread -> active (${threadId})`);
    return updated;
  }

  markExited(db: Database, threadId: number): ThreadRegistryEntry {
    const current = this.requireThread(db, threadId, "markExited");
    const nextState = current.type === "worker" && !current.keepAlive
      ? ThreadState.Exited
      : ThreadState.Active;
    this.assertTransition(current.status, nextState, "markExited");

    this.threadRepository.updateThread(db, threadId, {
      status: this.toPersistedState(nextState),
      lastActiveAt: new Date().toISOString(),
    });

    const updated = this.requireThread(db, threadId, "markExited");
    this.logger.info(`[thread-lifecycle] markExited -> ${nextState} (${threadId})`);
    return updated;
  }

  archiveThread(db: Database, threadId: number): ThreadRegistryEntry {
    const current = this.requireThread(db, threadId, "archiveThread");
    this.assertTransition(current.status, ThreadState.Archived, "archiveThread");

    this.threadRepository.updateThread(db, threadId, {
      status: ThreadState.Archived,
      keepAlive: false,
    });

    const updated = this.requireThread(db, threadId, "archiveThread");
    this.logger.info(`[thread-lifecycle] archiveThread -> archived (${threadId})`);
    return updated;
  }

  remapTopic(db: Database, input: RemapTopicInput): ThreadRegistryEntry {
    const current = this.requireThread(db, input.threadId, "remapTopic");
    this.assertTransition(current.status, ThreadState.Active, "remapTopic");

    this.threadRepository.updateThread(db, input.threadId, {
      status: ThreadState.Active,
      telegramTopicId: input.telegramTopicId,
      lastActiveAt: new Date().toISOString(),
    });
    this.syncTopicMappings(input.chatId, input.topicName, input.threadId, input.aliases);

    if (input.telegramTopicId !== input.threadId) {
      void this.telegramGateway.sendMessage(
        input.chatId,
        "Thread remapped. Continuing in the replacement topic.",
        undefined,
        input.telegramTopicId,
      ).catch(() => {
        this.logger.warn(
          `[thread-lifecycle] remapTopic notification failed for logical thread ${input.threadId}`,
        );
      });
    }

    const updated = this.requireThread(db, input.threadId, "remapTopic");
    this.logger.info(`[thread-lifecycle] remapTopic -> active (${input.threadId} -> ${input.telegramTopicId})`);
    return updated;
  }

  getThreadState(db: Database, threadId: number): ThreadState | null {
    const thread = this.threadRepository.getThread(db, threadId);
    return thread ? this.toLifecycleState(thread.status) : null;
  }

  private requireThread(db: Database, threadId: number, action: string): ThreadRegistryEntry {
    const thread = this.threadRepository.getThread(db, threadId);
    if (!thread) {
      throw new Error(`${action}: thread ${threadId} is not registered`);
    }
    return thread;
  }

  private assertTransition(
    current: PersistedThreadState | undefined,
    next: ThreadState,
    action: string,
  ): void {
    if (current === undefined) {
      if (next !== ThreadState.Active) {
        throw new Error(`${action}: unregistered threads can only transition to active`);
      }
      return;
    }

    const allowed = VALID_TRANSITIONS[this.toLifecycleState(current)];
    if (!allowed.has(next)) {
      throw new Error(`${action}: invalid transition ${current} -> ${next}`);
    }
  }

  private syncTopicMappings(
    chatId: string | undefined,
    name: string,
    threadId: number,
    aliases: string[] | undefined,
  ): void {
    if (!chatId) return;
    this.sessionRepository.setSession(chatId, name, threadId);
    this.sessionRepository.registerTopicRegistry(chatId, name, threadId);
    for (const alias of aliases ?? []) {
      if (!alias || alias === name) continue;
      this.sessionRepository.setSession(chatId, alias, threadId);
      this.sessionRepository.registerTopicRegistry(chatId, alias, threadId);
    }
  }

  private toLifecycleState(state: PersistedThreadState): ThreadState {
    return state as ThreadState;
  }

  private toPersistedState(state: ThreadState): PersistedThreadState {
    if (state === ThreadState.Dormant) {
      throw new Error("dormant is defined in the lifecycle model but is not yet persisted in thread_registry");
    }
    return state;
  }
}
