import { isValidAgentType, type AgentType } from "../config.js";

// ---------------------------------------------------------------------------
// Shared argument parsers (used by delegate-tool, start-session-tool)
// ---------------------------------------------------------------------------

/** Parse an unknown value to a positive integer, or return undefined. */
export function parsePositiveInt(v: unknown): number | undefined {
  const parsed = typeof v === "number" ? v
    : typeof v === "string" ? Number(v)
    : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Validate an agentType string. Returns the value if valid, otherwise `fallback`
 * (defaults to `undefined`).
 */
export function parseAgentType(raw: unknown, fallback?: AgentType): AgentType | undefined {
  const s = typeof raw === "string" ? raw.trim() : "";
  return isValidAgentType(s) ? s : fallback;
}
