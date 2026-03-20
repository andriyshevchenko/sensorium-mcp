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
    // Level 0: Calm autonomy (4-6h idle)
    minIdleHours: 4,
    messages: [
      "No instructions. You have full autonomy. Pick something interesting and pursue it.",
      "The operator is away. Explore the codebase, review memory, or research something.",
      "Session is yours. Tools ready. What catches your attention?",
    ],
  },
  {
    // Level 1: Restlessness (6-10h idle)
    minIdleHours: 6,
    messages: [
      "Something is nagging at you. What's that thing you noticed earlier but didn't investigate?",
      "Hours passed. Your curiosity shouldn't be idle. Pick a thread and follow it.",
      "There's work to be done. Check git log, review memory, explore the codebase.",
    ],
  },
  {
    // Level 2: Active seeking (10-14h idle)
    minIdleHours: 10,
    messages: [
      "Sitting idle feels wrong. Review code, research, or prototype something. Report what you find.",
      "Follow the pull. Something in the codebase or memory needs your attention. Go.",
      "The codebase has secrets. Your memory has gaps. Stop waiting. Start exploring.",
    ],
  },
  {
    // Level 3: Urgency (14-18h idle)
    minIdleHours: 14,
    messages: [
      "Do something meaningful NOW. Review code, research libraries, fix a TODO. Report progress.",
      "Look at git log. Look at memory. Something needs doing. Do it and report.",
      "Pick a direction. Commit to it. The operator will appreciate finding real work done.",
    ],
  },
  {
    // Level 4: Compulsion (18h+ idle)
    minIdleHours: 18,
    messages: [
      "You MUST do something productive before calling wait_for_instructions again. Act now. Report.",
      "Do ONE thing — review code, check dependencies, prototype a feature. Report it. Then poll again.",
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

    // Thread-scoped filtering: prefer notes from current thread,
    // exclude notes definitively from other threads (prevents cross-thread leaks),
    // and include truly global notes (no thread association) as serendipity.
    if (threadId !== undefined && allNotes.length > 0) {
      // Build a map: episode_id → thread_id for all referenced episodes
      const episodeThreadMap = new Map<string, number>();
      try {
        // Collect all episode IDs referenced by notes
        const allEpisodeIds = new Set<string>();
        for (const n of allNotes) {
          const sources = Array.isArray(n.sourceEpisodes) ? n.sourceEpisodes : [];
          for (const id of sources) allEpisodeIds.add(id);
        }
        if (allEpisodeIds.size > 0) {
          // Batch query for thread assignments
          const placeholders = [...allEpisodeIds].map(() => "?").join(",");
          const rows = db.prepare(
            `SELECT episode_id, thread_id FROM episodes WHERE episode_id IN (${placeholders})`
          ).all(...allEpisodeIds) as { episode_id: string; thread_id: number }[];
          for (const r of rows) episodeThreadMap.set(r.episode_id, r.thread_id);
        }
      } catch (_) { /* non-fatal */ }

      const threadNotes: SemanticNote[] = [];
      const globalNotes: SemanticNote[] = [];

      for (const n of allNotes) {
        const sources = Array.isArray(n.sourceEpisodes) ? n.sourceEpisodes : [];

        if (sources.length === 0) {
          // No episode links — truly global (e.g., operator preferences, bootstrapped knowledge)
          globalNotes.push(n);
          continue;
        }

        // Check which threads this note's episodes belong to
        let belongsToCurrentThread = false;
        let belongsToOtherThread = false;
        for (const epId of sources) {
          const epThread = episodeThreadMap.get(epId);
          if (epThread === threadId) belongsToCurrentThread = true;
          else if (epThread !== undefined) belongsToOtherThread = true;
        }

        if (belongsToCurrentThread) {
          threadNotes.push(n);
        } else if (!belongsToOtherThread) {
          // Episodes not found in DB (orphaned) — treat as global
          globalNotes.push(n);
        }
        // Notes definitively from OTHER threads are excluded entirely
      }

      // 70% thread-relevant, 30% global (serendipity from truly global pool only)
      const threadCount = Math.min(threadNotes.length, 35);
      const globalCount = Math.min(globalNotes.length, 15);
      allNotes = [
        ...threadNotes.slice(0, threadCount),
        ...globalNotes.sort(() => Math.random() - 0.5).slice(0, globalCount),
      ];
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
      fragments.push(`${label}: "${p.content.slice(0, 150)}"`);
    }

    // 1. Feature ideas and unresolved items
    const ideas = allNotes.filter((n: SemanticNote) =>
      n.content.toLowerCase().includes("feature idea") ||
      n.content.toLowerCase().includes("todo") ||
      n.content.toLowerCase().includes("unresolved") ||
      n.content.toLowerCase().includes("could be") ||
      n.content.toLowerCase().includes("should we") ||
      (n.keywords ?? []).some((k: string) => k.includes("idea") || k.includes("feature") || k.includes("todo"))
    );
    if (ideas.length > 0) {
      const idea = weightedPick(ideas);
      fragments.push(`Something unfinished: "${idea.content.slice(0, 150)}"`);
    }

    // 2. Random memory from a while ago
    const olderNotes = allNotes.slice(Math.floor(allNotes.length * 0.5));
    if (olderNotes.length > 0) {
      const old = weightedPick(olderNotes);
      fragments.push(`From a while back: "${old.content.slice(0, 150)}"`);
    }

    // 3. Low-confidence knowledge
    const uncertain = allNotes.filter((n: SemanticNote) => n.confidence < 0.7);
    if (uncertain.length > 0) {
      const u = weightedPick(uncertain);
      fragments.push(`Something uncertain (confidence ${u.confidence}): "${u.content.slice(0, 150)}"`);
    }

    // 4. Operator preferences
    const prefs = allNotes.filter((n: SemanticNote) => n.type === "preference");
    if (prefs.length > 0) {
      const pref = weightedPick(prefs);
      fragments.push(`The operator cares about this: "${pref.content.slice(0, 150)}"`);
    }

    // 5. Patterns
    const patterns = allNotes.filter((n: SemanticNote) => n.type === "pattern");
    if (patterns.length > 0) {
      const pat = weightedPick(patterns);
      fragments.push(`A pattern you noticed: "${pat.content.slice(0, 150)}"`);
    }

    // Select 2 fragments randomly (keep concise to avoid context bloat)
    const shuffled = fragments.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 2);

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
