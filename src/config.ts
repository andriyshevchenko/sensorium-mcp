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

export type AgentType = "copilot" | "copilot_claude" | "copilot_codex" | "claude" | "cursor" | "codex" | "openai_codex";

export const VALID_AGENT_TYPES: readonly string[] = [
  "copilot", "copilot_claude", "copilot_codex",
  "claude", "cursor",
  "codex", "openai_codex",
];

export function isValidAgentType(v: unknown): v is AgentType {
  return typeof v === "string" && VALID_AGENT_TYPES.includes(v);
}

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
  return isValidAgentType(t) ? t : "copilot";
}

export function setAgentType(type: AgentType): void {
  updateSettings(s => { s.agentType = type; });
}

// ─── Per-thread agent-type overrides ────────────────────────────────────────

/** Returns the per-thread agent-type override, or null if none is set. */
function getThreadAgentType(threadId: number): AgentType | null {
  const map = readSettings().threadAgentTypes as Record<string, unknown> | undefined;
  if (map) {
    const t = map[String(threadId)];
    if (isValidAgentType(t)) return t;
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
      if (isValidAgentType(v)) result[k] = v;
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

// ─── Bootstrap message count setting ────────────────────────────────────────

/** Default number of episodes for the bootstrap "Recent Conversation" section. */
const DEFAULT_BOOTSTRAP_MESSAGE_COUNT = 50;

/** Number of recent episodes injected into the bootstrap as "Recent Conversation". */
export function getBootstrapMessageCount(): number {
  const v = readSettings().bootstrapMessageCount;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return DEFAULT_BOOTSTRAP_MESSAGE_COUNT;
}

export function setBootstrapMessageCount(count: number): void {
  const clamped = Math.max(0, Math.round(count));
  if (!Number.isFinite(clamped)) return;
  updateSettings(s => { s.bootstrapMessageCount = clamped; });
}

// ─── Guardrails setting ─────────────────────────────────────────────────────

/** Whether guardrail (Active Decisions) notes are injected into memory briefings. */
export function getGuardrailsEnabled(): boolean {
  const v = readSettings().guardrailsEnabled;
  if (typeof v === "boolean") return v;
  return true; // default: enabled
}

export function setGuardrailsEnabled(enabled: boolean): void {
  updateSettings(s => { s.guardrailsEnabled = enabled; });
}

// ─── Keep-alive settings ─────────────────────────────────────────────────────

const DEFAULT_KEEP_ALIVE_MAX_RETRIES = 5;
const DEFAULT_KEEP_ALIVE_COOLDOWN_MS = 300_000;

export function getKeepAliveEnabled(): boolean {
  const v = readSettings().keepAliveEnabled;
  if (typeof v === "boolean") return v;
  return false; // default: disabled
}

export function setKeepAliveEnabled(enabled: boolean): void {
  updateSettings(s => { s.keepAliveEnabled = enabled; });
}

export function getKeepAliveThreadId(): number {
  const v = readSettings().keepAliveThreadId;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return 0;
}

export function setKeepAliveThreadId(threadId: number): void {
  updateSettings(s => { s.keepAliveThreadId = threadId; });
}

export function getKeepAliveMaxRetries(): number {
  const v = readSettings().keepAliveMaxRetries;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return DEFAULT_KEEP_ALIVE_MAX_RETRIES;
}

export function setKeepAliveMaxRetries(retries: number): void {
  updateSettings(s => { s.keepAliveMaxRetries = retries; });
}

export function getKeepAliveCooldownMs(): number {
  const v = readSettings().keepAliveCooldownMs;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return DEFAULT_KEEP_ALIVE_COOLDOWN_MS;
}

export function setKeepAliveCooldownMs(ms: number): void {
  updateSettings(s => { s.keepAliveCooldownMs = ms; });
}

// ─── Keep-alive client type ──────────────────────────────────────────────────

export type KeeperClient = "claude" | "copilot";

function isValidKeeperClient(v: unknown): v is KeeperClient {
  return v === "claude" || v === "copilot";
}

export function getKeepAliveClient(): KeeperClient {
  const v = readSettings().keepAliveClient;
  return isValidKeeperClient(v) ? v : "claude";
}

export function setKeepAliveClient(client: KeeperClient): void {
  updateSettings(s => { s.keepAliveClient = client; });
}

// ─── Per-thread keep-alive overrides ─────────────────────────────────────────

export interface ThreadKeepAliveSettings {
  enabled: boolean;
  client?: KeeperClient;
  maxRetries?: number;
  cooldownMs?: number;
}

/** Returns per-thread keep-alive settings, or null if none set. */
function getThreadKeepAlive(threadId: number): ThreadKeepAliveSettings | null {
  const map = readSettings().threadKeepAlive as Record<string, unknown> | undefined;
  if (!map || typeof map !== "object") return null;
  const entry = map[String(threadId)];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  return {
    enabled: typeof e.enabled === "boolean" ? e.enabled : false,
    client: isValidKeeperClient(e.client) ? e.client : undefined,
    cooldownMs: typeof e.cooldownMs === "number" && e.cooldownMs >= 1000 ? e.cooldownMs : undefined,
    maxRetries: typeof e.maxRetries === "number" && e.maxRetries > 0 ? e.maxRetries : undefined,
  };
}

/** Sets keep-alive settings for a specific thread. */
export function setThreadKeepAlive(threadId: number, settings: ThreadKeepAliveSettings): void {
  updateSettings(s => {
    const map = (s.threadKeepAlive ?? {}) as Record<string, unknown>;
    map[String(threadId)] = settings;
    s.threadKeepAlive = map;
  });
}

/** Removes per-thread keep-alive settings. */
export function removeThreadKeepAlive(threadId: number): void {
  updateSettings(s => {
    const map = (s.threadKeepAlive ?? {}) as Record<string, unknown>;
    delete map[String(threadId)];
    s.threadKeepAlive = map;
  });
}

/** Returns all per-thread keep-alive overrides. */
export function getAllThreadKeepAlive(): Record<string, ThreadKeepAliveSettings> {
  const map = readSettings().threadKeepAlive as Record<string, unknown> | undefined;
  if (!map || typeof map !== "object") return {};
  const result: Record<string, ThreadKeepAliveSettings> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v && typeof v === "object") {
      const e = v as Record<string, unknown>;
      result[k] = {
        enabled: typeof e.enabled === "boolean" ? e.enabled : false,
        client: isValidKeeperClient(e.client) ? e.client : undefined,
        cooldownMs: typeof e.cooldownMs === "number" && e.cooldownMs >= 1000 ? e.cooldownMs : undefined,
        maxRetries: typeof e.maxRetries === "number" && e.maxRetries > 0 ? e.maxRetries : undefined,
      };
    }
  }
  return result;
}



// ─── Ghost thread memory source ───────────────────────────────────────────

/**
 * Read the MEMORY_SOURCE_THREAD_ID env var set by the parent process
 * when spawning a ghost thread. Returns the parent thread ID for memory
 * briefing, or undefined if not a ghost thread.
 */
export function getMemorySourceThreadId(): number | undefined {
  const val = process.env.MEMORY_SOURCE_THREAD_ID;
  if (!val) return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read the MEMORY_TARGET_THREAD_ID env var set by the parent process.
 * When set, semantic notes, consolidation output, and narratives
 * write to this thread instead of the session's own thread.
 * Episodes always stay on the session's own thread.
 */
function getMemoryTargetThreadId(): number | undefined {
  const val = process.env.MEMORY_TARGET_THREAD_ID;
  if (!val) return undefined;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve where knowledge (notes, narratives) should be written.
 * Returns targetMemoryThreadId if set, otherwise falls back to sessionThreadId.
 */
export function resolveKnowledgeThreadId(sessionThreadId: number): number {
  return getMemoryTargetThreadId() ?? sessionThreadId;
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
