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

  if (!name || triggers.length === 0) return null;
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

/**
 * Explicit activation patterns — the message must contain one of these
 * for any skill to fire.  Prevents accidental triggers when a user just
 * mentions a skill-related word in regular conversation.
 */
const ACTIVATION_PATTERNS = [
  /\buse\s+(?:the\s+)?(?:[\w-]+\s+)?skill\b/i,
  /\bapply\s+(?:the\s+)?(?:[\w-]+\s+)?skill\b/i,
  /\bactivate\s+(?:the\s+)?(?:[\w-]+\s+)?skill\b/i,
  /\bwith\s+(?:the\s+)?(?:[\w-]+\s+)?skill\b/i,
  /@[\w-]+\s*skill\b/i,
];

/** Match operator message against skill trigger phrases (two-phase). Returns ALL matching skills, deduplicated. */
export function matchSkills(message: string): Skill[] {
  const normalizedMsg = message.toLowerCase().replace(/-/g, ' ');

  // Phase 1: Check for explicit activation intent
  const hasActivation = ACTIVATION_PATTERNS.some(p => p.test(message));
  if (!hasActivation) return [];

  const matched: Skill[] = [];
  const seen = new Set<string>();

  // Phase 2: Match specific skills by trigger
  const skills = loadSkills();
  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      if (normalizedMsg.includes(trigger.toLowerCase().replace(/-/g, ' ')) && !seen.has(skill.name)) {
        matched.push(skill);
        seen.add(skill.name);
      }
    }
  }

  // Phase 2b: Try matching by skill name directly
  for (const skill of skills) {
    if (normalizedMsg.includes(skill.name.toLowerCase().replace(/-/g, ' ')) && !seen.has(skill.name)) {
      matched.push(skill);
      seen.add(skill.name);
    }
  }

  return matched;
}

// ── Intent classification ─────────────────────────────────────────────────

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

type MessageIntent = "conversational" | "task";

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
