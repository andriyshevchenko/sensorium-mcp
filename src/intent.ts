/**
 * Lightweight intent classifier for operator messages.
 * Determines whether a message is conversational (acknowledgment, follow-up)
 * or a task request (requiring full orchestrator context).
 * Runs synchronously in < 0.1ms. Defaults to "task" when uncertain.
 *
 * Also provides a skill system: markdown files with YAML frontmatter that
 * can replace the default orchestrator prompt when trigger phrases match.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

// ── Skill types & loading ─────────────────────────────────────────────────

export interface Skill {
  name: string;
  triggers: string[];
  replacesOrchestrator: boolean;
  content: string;
  source: string; // file path
}

let skillCache: Skill[] = [];
let skillCacheTime = 0;
const SKILL_CACHE_TTL = 60_000;

/** Parse a markdown file with YAML frontmatter into a Skill (or null). */
function parseSkillFile(filePath: string): Skill | null {
  let raw: string;
  try { raw = readFileSync(filePath, "utf-8"); } catch { return null; }
  if (!raw.startsWith("---")) return null;

  const endIdx = raw.indexOf("---", 3);
  if (endIdx === -1) return null;

  const yaml = raw.slice(3, endIdx);
  const body = raw.slice(endIdx + 3).trim();

  // Minimal YAML parsing — no deps
  let name = "";
  const triggers: string[] = [];
  // NOTE: replacesOrchestrator: false is reserved for future use (partial-inject skills)
  let replacesOrchestrator = false;
  let currentKey = "";

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.endsWith(":") || (/^(\w+):/.test(trimmed) && !trimmed.startsWith("- "))) {
      currentKey = trimmed.split(":")[0].trim();
    }
    if (trimmed.startsWith("name:")) {
      name = trimmed.slice(5).trim().replace(/^["']|["']$/g, "");
    } else if (trimmed.startsWith("replaces_orchestrator:")) {
      replacesOrchestrator = trimmed.slice(22).trim() === "true";
    } else if (trimmed.startsWith("- ") && currentKey === "triggers") {
      triggers.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ""));
    }
  }

  if (!name || triggers.length === 0) {
    log.warn(`[skills] ${filePath}: frontmatter found but missing ${!name ? "name" : "triggers"} — skipping`);
    return null;
  }
  if (replacesOrchestrator && !body) return null;
  return { name, triggers, replacesOrchestrator, content: body, source: filePath };
}

/** Scan skill directories and return parsed skills (cached 60 s). */
export function loadSkills(): Skill[] {
  if (Date.now() - skillCacheTime < SKILL_CACHE_TTL) return skillCache;

  const skills: Skill[] = [];
  const seen = new Set<string>(); // dedupe by name (user overrides default)

  // 1. User skills: ~/.remote-copilot-mcp/skills/*.md
  const userDir = join(homedir(), ".remote-copilot-mcp", "skills");
  try {
    for (const f of readdirSync(userDir)) {
      if (!f.endsWith(".md")) continue;
      const sk = parseSkillFile(join(userDir, f));
      if (sk) { skills.push(sk); seen.add(sk.name); }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`[skills] Failed to read dir: ${err}`);
  }

  // 2. Default skills: templates/*.default.md (only those with frontmatter)
  const __dir = dirname(fileURLToPath(import.meta.url));
  const defaultDir = join(__dir, "..", "templates");
  try {
    for (const f of readdirSync(defaultDir)) {
      if (!f.endsWith(".default.md")) continue;
      const sk = parseSkillFile(join(defaultDir, f));
      if (sk && !seen.has(sk.name)) { skills.push(sk); seen.add(sk.name); }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`[skills] Failed to read dir: ${err}`);
  }

  // 3. Project skills: workspace root *.skill.md
  const projectDir = process.cwd();
  try {
    for (const f of readdirSync(projectDir)) {
      if (!f.endsWith(".skill.md")) continue;
      const sk = parseSkillFile(join(projectDir, f));
      if (sk && !seen.has(sk.name)) { skills.push(sk); seen.add(sk.name); }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`[skills] Failed to read dir: ${err}`);
  }

  // Warn on duplicate/shadowed triggers across skills (L3)
  const triggerOwner = new Map<string, string>();
  for (const sk of skills) {
    for (const t of sk.triggers) {
      const key = t.toLowerCase();
      const existing = triggerOwner.get(key);
      if (existing && existing !== sk.name) {
        log.warn(`[skills] Trigger "${t}" in skill "${sk.name}" shadows same trigger in "${existing}"`);
      } else {
        triggerOwner.set(key, sk.name);
      }
    }
  }

  skillCache = skills;
  skillCacheTime = Date.now();
  return skills;
}

/** Invalidate the skill cache so the next loadSkills() re-reads from disk. */
export function invalidateSkillCache(): void { skillCacheTime = 0; }

// ── Intent classification ─────────────────────────────────────────────────────────

// Pure acknowledgments — always conversational, never imply action
const PURE_ACK = new Set([
  "ok", "okay", "k", "no", "nope",
  "thanks", "thank you", "thx", "ty", "got it",
  "gotcha", "nice", "cool", "great", "perfect",
  "understood", "roger", "noted", "right", "correct",
  "indeed", "exactly", "interesting",
  "hi", "hey", "hello", "morning", "good morning",
  "lol", "haha", "heh", "wow",
  "makes sense", "sounds good",
  "leave it", "let’s leave it", "never mind", "nah", "forget it",
  "👍", "👌", "✅", "🙏",
]);

// Action CTAs — operator wants the agent to proceed → always task
const ACTION_CTA = new Set([
  "yes", "yep", "yup", "sure", "absolutely", "definitely", "agreed",
  "go ahead", "do it", "go on", "continue", "proceed",
  "let’s do it", "let's do it", "let’s go", "let's go",
]);

// Matches a task verb at the START of a message (imperative form).
const TASK_VERB_RE = /^(fix|implement|add|create|update|remove|delete|change|build|deploy|refactor|debug|test|write|configure|setup|set up|migrate|install|check|run|send|stop|start|restart|enable|disable|ship|push|publish|use|search|find|look|read|open|review|analyze|research|investigate)\b/;

// Matches a task verb ANYWHERE in a short message — catches "let's test",
// "please fix", "just run", "quickly check" etc. where the verb isn't first.
const TASK_VERB_ANYWHERE_RE = /\b(fix|implement|add|create|update|remove|delete|change|build|deploy|refactor|debug|test|write|configure|setup|migrate|install|check|run|send|stop|start|restart|enable|disable|ship|push|publish|search|find|review|analyze|research|investigate)\b/;

// ── Structural task signals ──────────────────────────────────────────────────

// Code content: inline code or fenced blocks
const HAS_CODE_RE = /`[^`]+`|```/;

// URLs
const HAS_URL_RE = /https?:\/\//i;

// Issue/PR references or commit-like hex strings (≥7 chars)
const HAS_REFERENCE_RE = /#\d{2,}|PR\s*#?\d+|\b[0-9a-f]{12,40}\b/i;

// Common code file extensions
const HAS_CODE_EXT_RE = /(?:[\w.-]+[\/\\])[\w.\/-]*\.(?:ts|js|tsx|jsx|py|go|rs|java|json|yaml|yml|toml|md|sh|css|html|vue|svelte|sql|xml|env|conf|cfg|ini|log|mjs|cjs)\b|\b[\w-]+\.[\w-]+\.(?:ts|js|tsx|jsx|py|go|rs|java|json|yaml|yml|toml|md|sh|css|html|vue|svelte|sql|xml|env|conf|cfg|ini|log|mjs|cjs)\b/;

// Polite imperative: "can you check...", "could you deploy..."
const QUESTION_TASK_RE = /^(can|could|would|will|shall)\s+(you|we)\b/i;

// "let’s" + word — "let’s deploy", "let’s fix this"
const LETS_VERB_RE = /^let[’']?s\s+\w/i;

// Multi-sentence: period followed by space+capital, or newline with content
const MULTI_SENTENCE_RE = /\.\s+[A-Z]|\n\s*\S/;

export type MessageIntent = "conversational" | "task";

export function classifyIntent(message: string): MessageIntent {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const wordCount = lower.split(/\s+/).length;

  // Tier 0: Structural signals — always task regardless of length
  if (HAS_CODE_RE.test(trimmed)) return "task";
  if (HAS_URL_RE.test(trimmed)) return "task";
  if (HAS_REFERENCE_RE.test(trimmed)) return "task";
  if (HAS_CODE_EXT_RE.test(trimmed)) return "task";

  // Tier 1: Pure acknowledgments — always conversational
  if (PURE_ACK.has(lower)) return "conversational";

  // Tier 2: Action CTAs — operator wants to proceed → task
  if (ACTION_CTA.has(lower)) return "task";

  // Tier 3: Question-form imperatives — "can you check...", "could you fix..."
  if (QUESTION_TASK_RE.test(lower)) return "task";

  // Tier 4: "let’s" + verb — "let’s deploy", "let’s fix this"
  if (LETS_VERB_RE.test(lower)) return "task";

  // Tier 5: Multi-sentence messages — almost always tasks
  if (MULTI_SENTENCE_RE.test(trimmed)) return "task";

  // Tier 6: Short messages (≤ 3 words) without any task verbs → conversational
  if (wordCount <= 3 && !TASK_VERB_RE.test(lower) && !TASK_VERB_ANYWHERE_RE.test(lower)) return "conversational";

  // Tier 7: Default to task (safe — includes full reminders)
  return "task";
}
