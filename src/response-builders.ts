/**
 * Response-builder helpers extracted from index.ts.
 *
 * These pure(‑ish) functions build the text fragments that are appended to
 * MCP tool responses so the agent always has essential context (thread ID,
 * time, uptime, operating-mode reminders, etc.).
 */

import { config, getEffectiveAgentType } from "./config.js";
import { describeADV } from "./utils.js";
import { loadTemplate, renderTemplate } from "./data/templates.js";
import type { VoiceAnalysisResult } from "./openai.js";
import { getDefaultRemindersTemplate } from "./dashboard/presets.js";
import type { ToolResult } from "./types.js";

export { loadTemplate, renderTemplate } from "./data/templates.js";

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
 * @param sessionStartedAt  Epoch ms when the current session started.
 * @param autonomousMode  Whether the agent is in autonomous orchestrator mode.
 */
export function getReminders(
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

  // ── Fallback: use agent-specific default template ────────────────────
  const defaultTpl = getDefaultRemindersTemplate(getEffectiveAgentType(threadId));
  const fallbackVars: Record<string, string> = {
    OPERATOR_MESSAGE: "",
    THREAD_ID: String(threadId ?? "?"),
    TIME: timeStr,
    UPTIME: `${uptimeMin}m`,
    VERSION: config.PKG_VERSION,
    MODE: autonomousMode ? "autonomous" : "standard",
  };
  return "\n" + renderTemplate(defaultTpl, fallbackVars).trim();
}

/**
 * Medium context — lightweight reminder with thread ID, time, uptime,
 * and mode. Omits memory auto-injection, drive content, and template
 * overrides to keep the payload lean.
 *
 * Used for conversational-intent messages where full context is overkill.
 *
 * @param threadId          Current Telegram thread ID (if any).
 * @param sessionStartedAt  Epoch ms when the current session started.
 * @param autonomousMode    Whether the agent is in autonomous mode.
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

  const mode = autonomousMode ? "autonomous" : "standard";

  return (
    `\nthreadId=${threadId ?? "?"} | ${timeStr} | uptime: ${uptimeMin}m | mode: ${mode}`
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

/**
 * Build the standardised maintenance-mode response returned when a server
 * update is in progress.  The poll-loop handler uses
 * this, so it lives here to avoid duplication.
 *
 * @param effectiveThreadId  Current Telegram thread ID.
 * @param shortReminder      Pre-computed short reminder suffix.
 */
export function buildMaintenanceResponse(
  effectiveThreadId: number,
  shortReminder: string,
): ToolResult {
  return {
    content: [{
      type: "text",
      text: `⚠️ Server update in progress. STOP.\n\n` +
        `Do NOT call start_session, wait_for_instructions, or any other tool on sensorium-mcp.\n\n` +
        `Your next action: Call the \`await_server_ready\` tool on the **sensorium-watcher** MCP server with threadId=${effectiveThreadId}. ` +
        `It will block until the update is complete, then return.\n\n` +
        `After it returns, call start_session with threadId=${effectiveThreadId} to reconnect.\n\n` +
        `If the sensorium-watcher MCP server is not available, use Desktop Commander to run: Start-Sleep -Seconds 600. Do nothing else until it completes.` +
        shortReminder,
    }],
  };
}
