/**
 * Episode CRUD operations for the memory system.
 *
 * Extracted from memory.ts — episodic memory layer.
 */

import type { Database } from "./schema.js";
import { generateId, nowISO, jsonOrNull, parseJsonArray, parseJsonObject } from "./utils.js";
import { log } from "../../logger.js";
import { errorMessage } from "../../utils.js";

// ─── Type Definitions ────────────────────────────────────────────────────────

export interface Episode {
  episodeId: string;
  sessionId: string;
  threadId: number;
  timestamp: string;
  type: "operator_message" | "agent_action" | "system_event" | "operator_reaction";
  modality: "text" | "voice" | "photo" | "video_note" | "document" | "mixed" | "reaction";
  content: Record<string, unknown>;
  topicTags: string[];
  importance: number;
  consolidated: boolean;
  accessedCount: number;
  lastAccessed: string | null;
  createdAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Row → Interface mapper ─────────────────────────────────────────────────

export function rowToEpisode(row: Record<string, unknown>): Episode {
  return {
    episodeId: row.episode_id as string,
    sessionId: row.session_id as string,
    threadId: row.thread_id as number,
    timestamp: row.timestamp as string,
    type: row.type as Episode["type"],
    modality: row.modality as Episode["modality"],
    content: parseJsonObject(row.content as string | null) as Record<string, unknown>,
    topicTags: parseJsonArray(row.topic_tags as string | null),
    importance: row.importance as number,
    consolidated: (row.consolidated as number) === 1,
    accessedCount: row.accessed_count as number,
    lastAccessed: (row.last_accessed as string) ?? null,
    createdAt: row.created_at as string,
  };
}

/** Default importance for agent action episodes (voice, progress reports). */
const AGENT_EPISODE_IMPORTANCE = 0.3;

// ─── Episodic Memory CRUD ────────────────────────────────────────────────────

export function saveEpisode(
  db: Database,
  episode: {
    sessionId: string;
    threadId: number;
    type: "operator_message" | "agent_action" | "system_event" | "operator_reaction";
    modality: "text" | "voice" | "photo" | "video_note" | "document" | "mixed" | "reaction";
    content: Record<string, unknown>;
    topicTags?: string[];
    importance?: number;
  }
): string {
  const id = generateId("ep");
  const now = nowISO();

  db.prepare(
    `INSERT INTO episodes
       (episode_id, session_id, thread_id, timestamp, type, modality, content, topic_tags, importance, consolidated, accessed_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
  ).run(
    id,
    episode.sessionId,
    episode.threadId,
    now,
    episode.type,
    episode.modality,
    JSON.stringify(episode.content),
    jsonOrNull(episode.topicTags),
    episode.importance ?? 0.5,
    now
  );

  return id;
}

export function getRecentEpisodes(db: Database, threadId: number, limit = 20, options?: { startTime?: string; endTime?: string; since?: string }): Episode[] {
  let sql = `SELECT * FROM episodes WHERE thread_id = ?`;
  const params: unknown[] = [threadId];
  if (options?.since) {
    sql += ` AND timestamp > ?`;
    params.push(options.since);
  }
  if (options?.startTime) {
    sql += ` AND timestamp >= ?`;
    params.push(options.startTime);
  }
  if (options?.endTime) {
    sql += ` AND timestamp <= ?`;
    params.push(options.endTime);
  }
  sql += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);
  const rows = db
    .prepare(sql)
    .all(...params) as Record<string, unknown>[];
  return rows.map(rowToEpisode);
}

export function getUnconsolidatedEpisodes(db: Database, threadId: number, limit = 50): Episode[] {
  const rows = db
    .prepare(
      `SELECT * FROM episodes WHERE thread_id = ? AND consolidated = 0 ORDER BY timestamp ASC LIMIT ?`
    )
    .all(threadId, limit) as Record<string, unknown>[];
  return rows.map(rowToEpisode);
}

/**
 * Fire-and-forget episode save for agent actions (voice, progress reports).
 * Wraps saveEpisode in a try/catch and logs failures instead of throwing.
 */
export function saveAgentEpisodeSafe(
  getMemoryDb: () => Database,
  params: {
    sessionStartedAt: number;
    threadId: number;
    modality: "text" | "voice";
    text: string;
  },
): void {
  try {
    const db = getMemoryDb();
    if (!db) return;
    saveEpisode(db, {
      sessionId: `session_${params.sessionStartedAt}`,
      threadId: params.threadId,
      type: "agent_action",
      modality: params.modality,
      content: { text: params.text },
      importance: AGENT_EPISODE_IMPORTANCE,
    });
  } catch (err) {
    log.warn(`[episode] Failed to save agent episode: ${errorMessage(err)}`);
  }
}

export function markConsolidated(db: Database, episodeIds: string[]): void {
  if (episodeIds.length === 0) return;
  const stmt = db.prepare(`UPDATE episodes SET consolidated = 1 WHERE episode_id = ?`);
  const txn = db.transaction(() => {
    for (const id of episodeIds) {
      stmt.run(id);
    }
  });
  txn();
}
