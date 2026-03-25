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

/** Safely parse a JSON string into an object, defaulting to {}. */
export function parseJsonObject(val: string | null | undefined): Record<string, unknown> {
  if (!val) return {};
  try {
    return JSON.parse(val);
  } catch {
    return {};
  }
}
