/**
 * Shared utility functions for the memory subsystem.
 *
 * Centralises helpers that were previously copy-pasted across
 * schema.ts, episodes.ts, semantic.ts, consolidation.ts,
 * voice-sig.ts, procedures.ts and bootstrap.ts.
 */

import { randomUUID } from "node:crypto";

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

// ── LLM JSON repair ──────────────────────────────────────────────────────────

/** Return true if the character at `pos` is preceded by an odd number of backslashes (i.e. escaped). */
function isEscaped(text: string, pos: number): boolean {
  let count = 0;
  let i = pos - 1;
  while (i >= 0 && text[i] === "\\") { count++; i--; }
  return count % 2 !== 0;
}

/**
 * Best-effort repair of malformed JSON returned by LLMs.
 * Handles: markdown fences, unescaped control chars, truncated structures.
 */
export function repairAndParseJSON(raw: string): unknown {
  try { return JSON.parse(raw); } catch { /* continue */ }

  let text = raw.trim();

  // Strip markdown code fences
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    try { return JSON.parse(text); } catch { /* continue */ }
  }

  // Fix unescaped control characters inside JSON string values
  const chars: string[] = [];
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && !isEscaped(text, i)) { inStr = !inStr; chars.push(ch); continue; }
    if (inStr) {
      if (ch === "\n") { chars.push("\\n"); continue; }
      if (ch === "\r") { chars.push("\\r"); continue; }
      if (ch === "\t") { chars.push("\\t"); continue; }
    }
    chars.push(ch);
  }
  text = chars.join("");
  try { return JSON.parse(text); } catch { /* continue */ }

  // Close truncated structures
  let quoteCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' && !isEscaped(text, i)) quoteCount++;
  }
  if (quoteCount % 2 !== 0) text += '"';

  text = text.replace(/,\s*"[^"]*"\s*:\s*$/, "");
  text = text.replace(/,\s*$/, "");

  const opens: string[] = [];
  let scanning = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && !isEscaped(text, i)) { scanning = !scanning; continue; }
    if (scanning) continue;
    if (c === "{" || c === "[") opens.push(c);
    else if (c === "}" || c === "]") opens.pop();
  }
  for (let i = opens.length - 1; i >= 0; i--) {
    text += opens[i] === "{" ? "}" : "]";
  }

  try { return JSON.parse(text); } catch { /* continue */ }
  throw new SyntaxError(`Unable to repair JSON from LLM (length=${raw.length}): ${raw.slice(0, 200)}\u2026`);
}
