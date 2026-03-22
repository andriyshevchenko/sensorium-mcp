/**
 * Episode CRUD operations for the memory system.
 *
 * Extracted from memory.ts — episodic memory layer.
 */

import { randomUUID } from "crypto";
import type { Database } from "./schema.js";

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

function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function jsonOrNull(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  return JSON.stringify(val);
}

function parseJsonArray(val: string | null | undefined): string[] {
  if (!val) return [];
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
}

function parseJsonObject(val: string | null | undefined): Record<string, unknown> {
  if (!val) return {};
  try {
    return JSON.parse(val);
  } catch {
    return {};
  }
}

// ─── Row → Interface mapper ─────────────────────────────────────────────────

function rowToEpisode(row: Record<string, unknown>): Episode {
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

export function getRecentEpisodes(db: Database, threadId: number, limit = 20): Episode[] {
  const rows = db
    .prepare(
      `SELECT * FROM episodes WHERE thread_id = ? ORDER BY timestamp DESC LIMIT ?`
    )
    .all(threadId, limit) as Record<string, unknown>[];
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
