/**
 * Response-builder helpers extracted from index.ts.
 *
 * These pure(‑ish) functions build the text fragments that are appended to
 * MCP tool responses so the agent always has essential context (thread ID,
 * time, uptime, operating-mode reminders, etc.).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { TEMPLATES_DIR } from "./config.js";
import { describeADV } from "./utils.js";
import type { VoiceAnalysisResult } from "./openai.js";

// ── Template loading & caching ────────────────────────────────────────────

const TEMPLATE_TTL_MS = 60_000; // 60-second cache TTL

interface CachedTemplate {
  content: string | null;
  loadedAt: number;
}

const templateCache = new Map<string, CachedTemplate>();

/**
 * Load a template file from ~/.remote-copilot-mcp/templates/{name}.md.
 * Returns the raw template string, or null if the file doesn't exist.
 * Results are cached in memory with a 60-second TTL.
 */
export function loadTemplate(name: string): string | null {
  const now = Date.now();
  const cached = templateCache.get(name);
  if (cached && now - cached.loadedAt < TEMPLATE_TTL_MS) {
    return cached.content;
  }

  const filePath = join(TEMPLATES_DIR, `${name}.md`);
  let content: string | null = null;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    // File doesn't exist or is unreadable — fall back to null
    content = null;
  }

  templateCache.set(name, { content, loadedAt: now });
  return content;
}

/**
 * Replace all `{{VAR}}` placeholders in a template string with the
 * corresponding values from the provided vars map.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });
}

// ── Stop-word list for auto-memory keyword extraction ─────────────────
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "ought",
  "i", "me", "my", "we", "us", "our", "you", "your", "he", "him",
  "his", "she", "her", "it", "its", "they", "them", "their", "this",
  "that", "these", "those", "what", "which", "who", "whom", "when",
  "where", "why", "how", "not", "no", "nor", "so", "too", "very",
  "just", "also", "than", "then", "now", "here", "there", "all",
  "any", "each", "every", "both", "few", "more", "most", "some",
  "such", "only", "own", "same", "but", "and", "or", "if", "at",
  "by", "for", "from", "in", "into", "of", "on", "to", "up", "with",
  "as", "about", "like", "hey", "hi", "hello", "ok", "okay", "please",
  "thanks", "thank", "yes", "yeah", "no", "nah", "right", "got",
  "get", "let", "go", "going", "gonna", "want", "know", "think",
  "see", "look", "make", "take", "give", "tell", "say", "said",
]);

/** Tokenize text and strip stop words, returning up to 10 meaningful keywords. */
export function extractSearchKeywords(text: string): string {
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
  return words.slice(0, 10).join(" ");
}

/**
 * Build human-readable analysis tags from a VoiceAnalysisResult.
 * Fields that are null / undefined / empty are silently skipped.
 */
export function buildAnalysisTags(analysis: VoiceAnalysisResult | null): string[] {
  const tags: string[] = [];
  if (!analysis) return tags;
  if (analysis.emotion) {
    let emotionStr = analysis.emotion;
    if (analysis.arousal != null && analysis.dominance != null && analysis.valence != null) {
      emotionStr += ` (${describeADV(analysis.arousal, analysis.dominance, analysis.valence)})`;
    }
    tags.push(`tone: ${emotionStr}`);
  }
  if (analysis.gender) tags.push(`gender: ${analysis.gender}`);
  if (analysis.audio_events && analysis.audio_events.length > 0) {
    const eventLabels = analysis.audio_events
      .map(e => `${e.label} (${Math.round(e.score * 100)}%)`)
      .join(", ");
    tags.push(`sounds: ${eventLabels}`);
  }
  if (analysis.paralinguistics) {
    const p = analysis.paralinguistics;
    const paraItems: string[] = [];
    if (p.speech_rate != null) paraItems.push(`${p.speech_rate} syl/s`);
    if (p.mean_pitch_hz != null) paraItems.push(`pitch ${p.mean_pitch_hz}Hz`);
    if (paraItems.length > 0) tags.push(`speech: ${paraItems.join(", ")}`);
  }
  return tags;
}

/**
 * Full reminders — only used for wait_for_instructions and start_session
 * responses where the agent needs the complete context for decision-making.
 *
 * @param threadId        Current Telegram thread ID (if any).
 * @param driveActive     Whether the dispatcher drive is currently active.
 * @param sessionStartedAt  Epoch ms when the current session started.
 * @param autonomousMode  Whether the agent is in autonomous orchestrator mode.
 */
export function getReminders(
  threadId: number | undefined,
  driveActive: boolean,
  sessionStartedAt: number,
  autonomousMode: boolean,
): string {
  const now = new Date();
  const uptimeMin = Math.round((Date.now() - sessionStartedAt) / 60000);
  const timeStr = now.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZoneName: "short",
  });

  // ── Try custom template ────────────────────────────────────────────────
  const tpl = loadTemplate("reminders");
  if (tpl !== null) {
    const vars: Record<string, string> = {
      OPERATOR_MESSAGE: "",           // not available at this call-site
      THREAD_ID: String(threadId ?? "?"),
      TIME: timeStr,
      UPTIME: `${uptimeMin}m`,
      VERSION: config.PKG_VERSION,
      MODE: autonomousMode ? "autonomous" : "standard",
    };
    return "\n" + renderTemplate(tpl, vars).trim();
  }

  // ── Hardcoded fallback (original behaviour) ────────────────────────────
  if (driveActive) {
    return (
      "\nComplete the dispatcher's tasks. Report progress via `send_voice`. Then call `remote_copilot_wait_for_instructions`." +
      ` threadId=${threadId ?? "?"} | ${timeStr} | uptime: ${uptimeMin}m`
    );
  }

  const directive = autonomousMode
    ? "\nYou are the ORCHESTRATOR. Your only permitted actions: plan, decide, call wait_for_instructions/hibernate/send_voice/report_progress/memory tools. ALL other work (file reads, edits, searches, code changes) MUST go through runSubagent. Non-negotiable."
    : "\nFollow the operator's instructions. Report results via `send_voice`.";

  return (
    directive +
    ` threadId=${threadId ?? "?"} | ${timeStr} | uptime: ${uptimeMin}m`
  );
}

/**
 * Medium context — includes the orchestrator directive (or standard
 * instruction) so the agent never loses the fundamental behavioral
 * constraint, but omits memory auto-injection, drive content, and
 * template overrides to keep the payload lean.
 *
 * Used for conversational-intent messages where full context is overkill
 * but the orchestrator guardrail must still be present.
 *
 * @param threadId          Current Telegram thread ID (if any).
 * @param sessionStartedAt  Epoch ms when the current session started.
 * @param autonomousMode    Whether the agent is in autonomous orchestrator mode.
 */
export function getMediumReminder(
  threadId: number | undefined,
  sessionStartedAt: number,
  autonomousMode: boolean,
): string {
  const now = new Date();
  const uptimeMin = Math.round((Date.now() - sessionStartedAt) / 60000);
  const timeStr = now.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZoneName: "short",
  });

  const directive = autonomousMode
    ? "\nYou are the ORCHESTRATOR. Your only permitted actions: plan, decide, call wait_for_instructions/hibernate/send_voice/report_progress/memory tools. ALL other work (file reads, edits, searches, code changes) MUST go through runSubagent. Non-negotiable."
    : "\nFollow the operator's instructions. Report results via `send_voice`.";

  return (
    directive +
    ` threadId=${threadId ?? "?"} | ${timeStr} | uptime: ${uptimeMin}m`
  );
}

/**
 * Minimal context — appended to regular tool responses to avoid bloating
 * the conversation context. Only includes thread ID and timestamp.
 *
 * @param threadId          Current Telegram thread ID (if any).
 * @param sessionStartedAt  Epoch ms when the current session started.
 */
export function getShortReminder(threadId: number | undefined, sessionStartedAt: number): string {
  const now = new Date();
  const uptimeMin = Math.round((Date.now() - sessionStartedAt) / 60000);
  const timeStr = now.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZoneName: "short",
  });
  const threadHint = threadId !== undefined
    ? `\n- Active Telegram thread ID: **${threadId}** — if this session is restarted, call start_session with threadId=${threadId} to resume this topic.`
    : "";
  return threadHint + `\n- Current time: ${timeStr} | Session uptime: ${uptimeMin}m`;
}
