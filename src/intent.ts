/**
 * Lightweight intent classifier for operator messages.
 * Determines whether a message is conversational (acknowledgment, follow-up)
 * or a task request (requiring full orchestrator context).
 * Runs synchronously in < 0.1ms. Defaults to "task" when uncertain.
 */

const ACK_EXACT = new Set([
  "ok", "okay", "k", "yes", "no", "yep", "nope", "yup",
  "sure", "thanks", "thank you", "thx", "ty", "got it",
  "gotcha", "nice", "cool", "great", "perfect", "agreed",
  "understood", "roger", "noted", "right", "correct",
  "indeed", "exactly", "absolutely", "definitely",
  "hi", "hey", "hello", "morning", "good morning",
  "lol", "haha", "heh", "wow", "interesting",
  "makes sense", "sounds good", "go ahead", "do it",
  "go on", "continue", "proceed", "leave it", "let's leave it",
  "👍", "👌", "✅", "🙏",
]);

const TASK_VERB_RE = /^(fix|implement|add|create|update|remove|delete|change|build|deploy|refactor|debug|test|write|configure|setup|set up|migrate|install|check|run|send|stop|start|restart|enable|disable|ship|push|publish|use|search|find|look|read|open|review|analyze|research|investigate)\b/;

export type MessageIntent = "conversational" | "task";

export function classifyIntent(message: string): MessageIntent {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const wordCount = lower.split(/\s+/).length;

  // Tier 1: Exact-match acknowledgments
  if (ACK_EXACT.has(lower)) return "conversational";

  // Tier 2: Very short messages (≤ 3 words) without imperative task verbs
  if (wordCount <= 3 && !TASK_VERB_RE.test(lower)) return "conversational";

  // Tier 3: Default to task (safe — includes full reminders)
  return "task";
}
