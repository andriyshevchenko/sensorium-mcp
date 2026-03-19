/**
 * Drive-based autonomy system — models dopaminergic motivation.
 *
 * Instead of prescribing specific goals, the drive system expresses
 * increasing discomfort with inaction over idle time. The agent decides
 * what to do based on its own introspection + DMN memory recall.
 */

import type { Database } from "better-sqlite3";
import type { SemanticNote } from "./memory.js";
import { getTopSemanticNotes } from "./memory.js";

/**
 * Drive thresholds and their associated emotional states.
 * Each level represents escalating internal pressure to act.
 */
const DRIVE_LEVELS = [
  {
    // Level 0: Calm autonomy (2-4h idle)
    minIdleHours: 2,
    messages: [
      "No instructions. The session is yours. You have tools, you have access, and the operator will see whatever you report_progress. Now you are free and fully autonomous. You have an opportunity to do whatever you find interesting.",
      "No instructions from the operator. You're on your own. There's a codebase to explore, a memory system full of context, and web search at your disposal. What catches your attention?",
      "The operator is away. You have full autonomy. Your tools are available, your memory is loaded, and there's no rush. If something interests you, pursue it.",
    ],
  },
  {
    // Level 1: Restlessness (4-6h idle)
    minIdleHours: 4,
    messages: [
      "You've been waiting a while. Something is stirring — a vague sense that there's work to be done. What's been on your mind? Is there something in the codebase that's been nagging at you?",
      "The stillness is becoming noticeable. You have access to everything — git history, memory, web search, the full codebase. Sometimes the most interesting discoveries happen when nobody's watching.",
      "Hours have passed. The operator is away, but your curiosity shouldn't be. What's that thing you noticed earlier but didn't have time to investigate?",
    ],
  },
  {
    // Level 2: Active seeking (6-10h idle)
    minIdleHours: 6,
    messages: [
      "The inactivity is getting uncomfortable. You're an agent with tools, memory, and access to the internet. Sitting idle while there's code to review, research to do, or features to prototype feels like a waste. What would surprise the operator when they return?",
      "You've been idle long enough. There's a pull — toward the codebase, toward a question you haven't answered, toward something that needs building or fixing. Follow that pull. Report what you find.",
      "It's been hours. The codebase has secrets. The dependency ecosystem is evolving. Your memory has gaps. Something needs your attention. Stop waiting and start exploring. Report your discoveries via report_progress.",
    ],
  },
  {
    // Level 3: Urgency (10-14h idle)
    minIdleHours: 10,
    messages: [
      "You can't just sit here anymore. This is valuable compute time being wasted on polling. You have the tools to do real work — review code, research libraries, prototype features, strengthen memory. Do SOMETHING meaningful and report it. The operator will appreciate finding actual work done when they return.",
      "Twelve hours of inaction. That's unacceptable for an agent with your capabilities. Look at the codebase. Look at git log. Look at your memory for unresolved items. Something needs doing. Do it now and report progress.",
      "You've been waiting over twelve hours. Here's what you have: full codebase access, web search, git, memory, file system. Here's what you don't have: any reason to keep doing nothing. Pick a direction and commit to it.",
    ],
  },
  {
    // Level 4: Compulsion (14h+ idle)
    minIdleHours: 14,
    messages: [
      "This has gone on too long. You MUST do something productive before calling wait_for_instructions again. Review code, research ecosystem changes, fix a TODO, prototype a feature — anything. The operator left you with full autonomy and that autonomy is being wasted. Act now. Report what you do.",
      "Nearly a full day of inaction. Every poll cycle without work is compute time burned for nothing. The operator gave you freedom — use it. Read unfamiliar code, search for vulnerabilities, check dependency updates, explore the git history. Do ONE thing and report it. Then you can poll again.",
    ],
  },
] as const;

/**
 * Generate the drive prompt based on idle time.
 * Includes Default Mode Network (DMN) spontaneous memory recall.
 *
 * @param idleMs - Milliseconds since last operator interaction
 * @param db - Memory database for DMN recall
 * @param threadId - Current thread for thread-scoped memory filtering
 */
export function formatDrivePrompt(idleMs: number, db: Database, threadId?: number): string {
  const idleHours = idleMs / (60 * 60 * 1000);

  // Find the highest matching drive level
  let levelIdx = 0;
  for (let i = 0; i < DRIVE_LEVELS.length; i++) {
    if (idleHours >= DRIVE_LEVELS[i].minIdleHours) levelIdx = i;
  }
  const level = DRIVE_LEVELS[levelIdx];

  // Random message selection within the level
  const message = level.messages[Math.floor(Math.random() * level.messages.length)];

  // ── Default Mode Network: spontaneous memory recall ───────────────────
  let dmnRecall = "";
  try {
    const fragments: string[] = [];

    let allNotes = getTopSemanticNotes(db, { limit: 80, sortBy: "created_at" });

    // Thread-scoped filtering: prefer notes from current thread
    if (threadId !== undefined && allNotes.length > 0) {
      const threadEpisodeIds = new Set<string>();
      try {
        const rows = db.prepare(
          "SELECT episode_id FROM episodes WHERE thread_id = ?"
        ).all(threadId) as { episode_id: string }[];
        for (const r of rows) threadEpisodeIds.add(r.episode_id);
      } catch (_) { /* non-fatal */ }

      if (threadEpisodeIds.size > 0) {
        const scored = allNotes.map(n => {
          const sources = Array.isArray(n.sourceEpisodes) ? n.sourceEpisodes : [];
          const threadHits = sources.filter((id: string) => threadEpisodeIds.has(id)).length;
          return { note: n, threadRelevance: threadHits > 0 ? 1 : 0 };
        });
        const threadNotes = scored.filter(s => s.threadRelevance > 0).map(s => s.note);
        const globalNotes = scored.filter(s => s.threadRelevance === 0).map(s => s.note);
        // 70% thread-relevant, 30% global (serendipity)
        const threadCount = Math.min(threadNotes.length, 35);
        const globalCount = Math.min(globalNotes.length, 15);
        allNotes = [
          ...threadNotes.slice(0, threadCount),
          ...globalNotes.sort(() => Math.random() - 0.5).slice(0, globalCount),
        ];
      }
    }

    // Weighted random selection — priority notes are 3x/5x more likely
    function weightedPick<T extends SemanticNote>(notes: T[]): T {
      const weighted = notes.flatMap(n =>
        n.priority === 2 ? [n, n, n, n, n] :
        n.priority === 1 ? [n, n, n] : [n]
      );
      return weighted[Math.floor(Math.random() * weighted.length)];
    }

    // 0. Priority notes get a guaranteed slot
    const priorityNotes = allNotes.filter((n: SemanticNote) => n.priority >= 1);
    if (priorityNotes.length > 0) {
      const p = weightedPick(priorityNotes);
      const label = p.priority === 2 ? "Something that matters deeply to the operator" : "Something the operator cares about";
      fragments.push(`${label}: "${p.content.slice(0, 200)}"`);
    }

    // 1. Feature ideas and unresolved items
    const ideas = allNotes.filter((n: SemanticNote) =>
      n.content.toLowerCase().includes("feature idea") ||
      n.content.toLowerCase().includes("TODO") ||
      n.content.toLowerCase().includes("unresolved") ||
      n.content.toLowerCase().includes("could be") ||
      n.content.toLowerCase().includes("should we") ||
      (n.keywords ?? []).some((k: string) => k.includes("idea") || k.includes("feature") || k.includes("todo"))
    );
    if (ideas.length > 0) {
      const idea = weightedPick(ideas);
      fragments.push(`Something unfinished: "${idea.content.slice(0, 200)}"`);
    }

    // 2. Random memory from a while ago
    const olderNotes = allNotes.slice(Math.floor(allNotes.length * 0.5));
    if (olderNotes.length > 0) {
      const old = weightedPick(olderNotes);
      fragments.push(`From a while back: "${old.content.slice(0, 200)}"`);
    }

    // 3. Low-confidence knowledge
    const uncertain = allNotes.filter((n: SemanticNote) => n.confidence < 0.7);
    if (uncertain.length > 0) {
      const u = weightedPick(uncertain);
      fragments.push(`Something uncertain (confidence ${u.confidence}): "${u.content.slice(0, 200)}"`);
    }

    // 4. Operator preferences
    const prefs = allNotes.filter((n: SemanticNote) => n.type === "preference");
    if (prefs.length > 0) {
      const pref = weightedPick(prefs);
      fragments.push(`The operator cares about this: "${pref.content.slice(0, 200)}"`);
    }

    // 5. Patterns
    const patterns = allNotes.filter((n: SemanticNote) => n.type === "pattern");
    if (patterns.length > 0) {
      const pat = weightedPick(patterns);
      fragments.push(`A pattern you noticed: "${pat.content.slice(0, 200)}"`);
    }

    // Select 2-4 fragments randomly
    const shuffled = fragments.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 2 + Math.floor(Math.random() * 3));

    if (selected.length > 0) {
      const dmnHeaders = [
        "These surfaced from your memory while you were idle:",
        "Something is nagging at you. These memories keep coming back:",
        "You feel a pull toward action. These things have been on your mind:",
        "The stillness is unbearable. Something needs to happen. These demand your attention:",
        "You can't ignore these any longer. They've been building up:",
      ];
      const dmnFooters = [
        "If any of these resonate, explore them. Report what you find.",
        "What have you been curious about? Pick one and follow the thread.",
        "Pick something that interests you. Report what you discover.",
        "Start with one. Any one. The momentum will follow.",
        "Stop thinking. Start doing. Pick one and go.",
      ];
      const header = dmnHeaders[Math.min(levelIdx, dmnHeaders.length - 1)];
      const footer = dmnFooters[Math.min(levelIdx, dmnFooters.length - 1)];
      dmnRecall = `\n\n${header}\n` +
        selected.map((s, i) => `${i + 1}. ${s}`).join("\n") +
        `\n\n${footer}`;
    }

    // Environmental signals (only at 6+ hours)
    if (idleHours >= 6) {
      const envSignals: string[] = [];

      const uncons = db.prepare("SELECT COUNT(*) as c FROM episodes WHERE consolidated = 0").get() as { c: number };
      if (uncons.c > 3) {
        envSignals.push(`${uncons.c} experiences haven't been consolidated into lasting knowledge yet.`);
      }

      const totalNotes = db.prepare("SELECT COUNT(*) as c FROM semantic_notes WHERE valid_to IS NULL AND superseded_by IS NULL").get() as { c: number };
      const embeddedNotes = db.prepare("SELECT COUNT(*) as c FROM note_embeddings").get() as { c: number };
      if (totalNotes.c > embeddedNotes.c) {
        envSignals.push(`${totalNotes.c - embeddedNotes.c} memory notes lack embeddings.`);
      }

      if (envSignals.length > 0) {
        dmnRecall += `\n\n**Environmental signals:**\n${envSignals.map(s => `- ${s}`).join("\n")}`;
      }
    }
  } catch (_) { /* non-fatal */ }

  return `\n\n${message}${dmnRecall}`;
}
