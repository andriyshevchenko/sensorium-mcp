/**
 * Centralized configuration — reads environment variables at startup
 * and exports validated values used throughout the codebase.
 */

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";
import type { AppConfig } from "./types.js";
import { FILES_DIR } from "./data/file-storage.js";

const esmRequire = createRequire(import.meta.url);
const { version: PKG_VERSION } = esmRequire("../package.json") as { version: string };

// ─── Environment variables ──────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const VOICE_ANALYSIS_URL = process.env.VOICE_ANALYSIS_URL ?? "";
const AUTONOMOUS_MODE = process.env.AUTONOMOUS_MODE === "true";

const rawWaitTimeoutMinutes = parseInt(process.env.WAIT_TIMEOUT_MINUTES ?? "", 10);
const WAIT_TIMEOUT_MINUTES = Math.max(1, Number.isFinite(rawWaitTimeoutMinutes) ? rawWaitTimeoutMinutes : 120);

const rawDmnActivationHours = parseFloat(process.env.DMN_ACTIVATION_HOURS ?? "");
const DMN_ACTIVATION_HOURS = Math.max(0.5, Number.isFinite(rawDmnActivationHours) ? rawDmnActivationHours : 4);

// ─── Validation ─────────────────────────────────────────────────────────────

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  log.error("TELEGRAM_TOKEN and TELEGRAM_CHAT_ID environment variables are required.");
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  log.warn("OPENAI_API_KEY not set — voice messages will not be transcribed.");
}
if (VOICE_ANALYSIS_URL) {
  log.info(`Voice analysis service configured: ${VOICE_ANALYSIS_URL}`);
}

// ─── Templates directory ────────────────────────────────────────────────────

export const TEMPLATES_DIR = join(homedir(), ".remote-copilot-mcp", "templates");
mkdirSync(TEMPLATES_DIR, { recursive: true });

// ─── Agent-type settings ────────────────────────────────────────────────────

export type AgentType = "copilot" | "claude" | "cursor";

const SETTINGS_PATH = join(homedir(), ".remote-copilot-mcp", "settings.json");
const SETTINGS_TMP_PATH = SETTINGS_PATH + ".tmp";

/** Atomically persist settings: write to .tmp then rename over the original. */
function atomicWriteSettings(settings: Record<string, unknown>): void {
  writeFileSync(SETTINGS_TMP_PATH, JSON.stringify(settings, null, 2), "utf-8");
  renameSync(SETTINGS_TMP_PATH, SETTINGS_PATH);
}

/** Read and parse the settings file, returning an empty object on any failure. */
function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
  } catch { return {}; }
}

/** Read settings, apply a mutator, and atomically persist the result. */
function updateSettings(mutator: (s: Record<string, unknown>) => void): void {
  const settings = readSettings();
  mutator(settings);
  atomicWriteSettings(settings);
}

export function getAgentType(): AgentType {
  const t = readSettings().agentType;
  if (t === "copilot" || t === "claude" || t === "cursor") return t;
  return "copilot";
}

export function setAgentType(type: AgentType): void {
  updateSettings(s => { s.agentType = type; });
}

// ─── Per-thread agent-type overrides ────────────────────────────────────────

/** Returns the per-thread agent-type override, or null if none is set. */
export function getThreadAgentType(threadId: number): AgentType | null {
  const map = readSettings().threadAgentTypes as Record<string, unknown> | undefined;
  if (map) {
    const t = map[String(threadId)];
    if (t === "copilot" || t === "claude" || t === "cursor") return t;
  }
  return null;
}

/** Persists a per-thread agent-type override. */
export function setThreadAgentType(threadId: number, agentType: AgentType): void {
  updateSettings(s => {
    const map = (s.threadAgentTypes ?? {}) as Record<string, unknown>;
    map[String(threadId)] = agentType;
    s.threadAgentTypes = map;
  });
}

/** Returns all per-thread agent-type overrides. */
export function getAllThreadAgentTypes(): Record<string, AgentType> {
  const map = readSettings().threadAgentTypes as Record<string, string> | undefined;
  if (map && typeof map === "object") {
    const result: Record<string, AgentType> = {};
    for (const [k, v] of Object.entries(map)) {
      if (v === "copilot" || v === "claude" || v === "cursor") result[k] = v;
    }
    return result;
  }
  return {};
}

/**
 * Returns the effective agent type for a given thread.
 * Per-thread override takes precedence over the global default.
 */
export function getEffectiveAgentType(threadId?: number): AgentType {
  if (threadId !== undefined) {
    const override = getThreadAgentType(threadId);
    if (override) return override;
  }
  return getAgentType();
}

// ─── Claude MCP config path setting ─────────────────────────────────────────

/** Returns the dashboard-configured Claude MCP config path, or null if unset. */
export function getClaudeMcpConfigPath(): string | null {
  const p = readSettings().claudeMcpConfigPath;
  if (typeof p === "string" && p.length > 0) return p;
  return null;
}

/** Persists the Claude MCP config path override. */
export function setClaudeMcpConfigPath(path: string): void {
  updateSettings(s => { s.claudeMcpConfigPath = path; });
}

// ─── Exported config object ─────────────────────────────────────────────────

export const config: AppConfig = {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  OPENAI_API_KEY,
  VOICE_ANALYSIS_URL,
  WAIT_TIMEOUT_MINUTES,
  DMN_ACTIVATION_HOURS,
  FILES_DIR,
  PKG_VERSION,
  AUTONOMOUS_MODE,
};
