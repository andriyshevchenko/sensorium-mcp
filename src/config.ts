/**
 * Centralized configuration — reads environment variables at startup
 * and exports validated values used throughout the codebase.
 */

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";
import type { AppConfig } from "./types.js";
import { FILES_DIR } from "./data/file-storage.js";

export { saveFileToDisk, checkMaintenanceFlag } from "./data/file-storage.js";

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

export function getAgentType(): AgentType {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    const t = raw.agentType;
    if (t === "copilot" || t === "claude" || t === "cursor") return t;
  } catch { /* missing or invalid settings file */ }
  return "copilot";
}

export function setAgentType(type: AgentType): void {
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>; } catch { /* ok */ }
  settings.agentType = type;
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
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
