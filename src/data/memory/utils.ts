/**
 * Shared utility functions for the memory subsystem.
 *
 * Centralises helpers that were previously copy-pasted across
 * schema.ts, episodes.ts, semantic.ts, consolidation.ts,
 * voice-sig.ts, procedures.ts and bootstrap.ts.
 */

import { randomUUID } from "crypto";

/** Generate a prefixed unique identifier (e.g. "sn_a1b2c3d4e5f6"). */
export function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Current UTC time as an ISO-8601 string. */
export function nowISO(): string {
  return new Date().toISOString();
}

/** JSON-stringify a value, returning null for undefined/null inputs. */
export function jsonOrNull(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  return JSON.stringify(val);
}

/** Safely parse a JSON string into a string array, defaulting to []. */
export function parseJsonArray(val: string | null | undefined): string[] {
  if (!val) return [];
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
}

// ─── Relative Time Parsing ───────────────────────────────────────────────────

/**
 * Parse a human-readable relative time string or ISO-8601 timestamp into an
 * ISO-8601 string.  Returns `undefined` for unrecognised input.
 *
 * Supported formats:
 *   - ISO-8601 strings (returned as-is)
 *   - "last 24h", "last 24 hours"
 *   - "last 7d", "last 7 days", "last week"
 *   - "last 1h", "last hour"
 *   - "yesterday"
 *   - "today"
 */
export function parseRelativeTime(input: string): string | undefined {
  if (!input || typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;

  // ISO-8601 — if it parses to a valid date, return it
  const asDate = new Date(trimmed);
  if (!isNaN(asDate.getTime()) && /\d{4}-\d{2}/.test(trimmed)) {
    return asDate.toISOString();
  }

  const now = new Date();
  const lower = trimmed.toLowerCase();

  // "today" → start of today (UTC)
  if (lower === "today") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return d.toISOString();
  }

  // "yesterday" → start of yesterday (UTC)
  if (lower === "yesterday") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    return d.toISOString();
  }

  // "last week" → 7 days ago
  if (lower === "last week") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  // "last hour" → 1 hour ago
  if (lower === "last hour") {
    return new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  }

  // "last Nh", "last N hours", "last Nd", "last N days"
  const m = lower.match(/^last\s+(\d+)\s*(h|hours?|d|days?)$/i);
  if (m) {
    const num = parseInt(m[1], 10);
    const unit = m[2].startsWith("h") ? "h" : "d";
    const ms = unit === "h" ? num * 60 * 60 * 1000 : num * 24 * 60 * 60 * 1000;
    return new Date(now.getTime() - ms).toISOString();
  }

  return undefined;
}

/** Safely parse a JSON string into an object, defaulting to {}. */
export function parseJsonObject(val: string | null | undefined): Record<string, unknown> {
  if (!val) return {};
  try {
    return JSON.parse(val);
  } catch {
    return {};
  }
}
