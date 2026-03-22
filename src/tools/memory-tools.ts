/**
 * Memory tool handlers extracted from index.ts.
 *
 * All memory_* tools are dispatched through `handleMemoryTool`.
 */

import {
  findPotentialConflicts,
  forgetMemory,
  getMemoryStatus,
  getNotesWithoutEmbeddings,
  getRecentEpisodes,
  getTopicIndex,
  type initMemoryDb,
  runIntelligentConsolidation,
  saveNoteEmbedding,
  saveSemanticNote,
  searchByEmbedding,
  searchProcedures,
  searchSemanticNotes,
  supersedeNote,
  updateProcedure,
  updateSemanticNote,
} from "../memory.js";
import { generateEmbedding } from "../openai.js";
import { log } from "../logger.js";
import { errorMessage } from "../utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Closure-bound helpers passed by the caller (index.ts createMcpServer). */
export interface ToolContext {
  resolveThreadId: (args: Record<string, unknown>) => number | undefined;
  getShortReminder: (threadId: number | undefined) => string;
  getMemoryDb: () => ReturnType<typeof initMemoryDb>;
  errorResult: (msg: string) => { content: Array<{ type: string; text: string }>; isError: true };
  /** Called when consolidation completes so the caller can update its timestamp. */
  onConsolidation?: () => void;
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Backfill embeddings for any semantic notes that don't have them yet.
 * Used after consolidation to ensure all notes are searchable by embedding.
 */
export async function backfillEmbeddings(db: ReturnType<typeof initMemoryDb>): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;
  const missing = getNotesWithoutEmbeddings(db);
  for (const { noteId, content } of missing) {
    try {
      const emb = await generateEmbedding(content, apiKey);
      saveNoteEmbedding(db, noteId, emb);
      log.verbose("memory", `Embedded ${noteId}`);
    } catch (err) {
      log.error(`[memory] Embedding failed for ${noteId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handleMemoryTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { resolveThreadId, getShortReminder, getMemoryDb, errorResult } = ctx;

  switch (name) {
    // ── memory_search ─────────────────────────────────────────────────────
    case "memory_search": {
      const threadId = resolveThreadId(args);
      const query = String(args.query ?? "");
      if (!query) {
        return errorResult("Error: query is required." + getShortReminder(threadId));
      }
      try {
        const db = getMemoryDb();
        const layers = Array.isArray(args.layers) ? args.layers.map(String) : typeof args.layers === 'string' ? [args.layers] : ["episodic", "semantic", "procedural"];
        const types = Array.isArray(args.types) ? args.types.map(String) : typeof args.types === 'string' ? [args.types] : undefined;
        const results: string[] = [];

        if (layers.includes("semantic")) {
          // Try embedding-based search first, fall back to keyword search
          const apiKey = process.env.OPENAI_API_KEY;
          let embeddingSearchDone = false;
          if (apiKey) {
            try {
              const queryEmb = await generateEmbedding(query, apiKey);
              const embNotes = searchByEmbedding(db, queryEmb, { maxResults: 10, minSimilarity: 0.25 });
              if (embNotes.length > 0) {
                results.push("### Semantic Memory (embedding search)");
                for (const n of embNotes) {
                  results.push(`- **[${n.type}]** ${n.content} _(conf: ${n.confidence}, sim: ${n.similarity.toFixed(2)}, id: ${n.noteId})_`);
                }
                embeddingSearchDone = true;
              }
            } catch (embErr) {
              log.warn(`[memory] Embedding search failed in memory_search, falling back to keyword: ${embErr instanceof Error ? embErr.message : String(embErr)}`);
            }
          }
          if (!embeddingSearchDone) {
            const notes = searchSemanticNotes(db, query, { types, maxResults: 10 });
            if (notes.length > 0) {
              results.push("### Semantic Memory");
              for (const n of notes) {
                results.push(`- **[${n.type}]** ${n.content} _(conf: ${n.confidence}, id: ${n.noteId})_`);
              }
            }
          }
        }

        if (layers.includes("procedural")) {
          const procs = searchProcedures(db, query, 5);
          if (procs.length > 0) {
            results.push("### Procedural Memory");
            for (const p of procs) {
              results.push(`- **${p.name}** (${p.type}): ${p.description} _(success: ${Math.round(p.successRate * 100)}%, id: ${p.procedureId})_`);
            }
          }
        }

        if (layers.includes("episodic") && threadId !== undefined) {
          const episodes = getRecentEpisodes(db, threadId, 10);
          const filtered = episodes.filter(ep => {
            const content = JSON.stringify(ep.content).toLowerCase();
            return query.toLowerCase().split(/\s+/).some(word => content.includes(word));
          });
          if (filtered.length > 0) {
            results.push("### Episodic Memory");
            for (const ep of filtered.slice(0, 5)) {
              const summary = typeof ep.content === "object" && ep.content !== null
                ? (ep.content as Record<string, unknown>).text ?? JSON.stringify(ep.content).slice(0, 200)
                : String(ep.content).slice(0, 200);
              results.push(`- [${ep.modality}] ${summary} _(${ep.timestamp}, id: ${ep.episodeId})_`);
            }
          }
        }

        const text = results.length > 0
          ? results.join("\n")
          : `No memories found for "${query}".`;
        return { content: [{ type: "text", text: text + getShortReminder(threadId) }] };
      } catch (err) {
        return errorResult(`Memory search error: ${errorMessage(err)}` + getShortReminder(threadId));
      }
    }

    // ── memory_save ───────────────────────────────────────────────────────
    case "memory_save": {
      const threadId = resolveThreadId(args);
      const VALID_TYPES = ["fact", "preference", "pattern", "entity", "relationship"] as const;
      const noteType = String(args.type ?? "fact");
      if (!VALID_TYPES.includes(noteType as typeof VALID_TYPES[number])) {
        return errorResult(`Invalid type "${noteType}". Must be one of: ${VALID_TYPES.join(", ")}`);
      }
      try {
        const db = getMemoryDb();
        const content = String(args.content ?? "").trim();
        if (!content) {
          return errorResult("Error: 'content' is required and cannot be empty.");
        }
        const noteId = saveSemanticNote(db, {
          type: noteType as typeof VALID_TYPES[number],
          content,
          keywords: Array.isArray(args.keywords) ? args.keywords.map(String) : typeof args.keywords === 'string' ? [args.keywords] : [],
          confidence: typeof args.confidence === "number" ? args.confidence : 0.8,
          priority: typeof args.priority === "number" ? args.priority : 0,
          threadId: threadId ?? null,
        });
        // Fire-and-forget embedding generation
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey) {
            void generateEmbedding(content, apiKey).then(emb => {
                saveNoteEmbedding(getMemoryDb(), noteId, emb);
            }).catch(err => {
                log.error(`[memory] Embedding failed for ${noteId}: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
        // Check for potential conflicts with existing notes
        let conflictWarning = "";
        try {
          const conflicts = findPotentialConflicts(db, noteId);
          if (conflicts.length > 0) {
            const ids = conflicts.map(c => c.noteId).join(", ");
            conflictWarning = `\n⚠️ Potential conflicts detected with: ${ids}. Consider reviewing and superseding stale notes.`;
          }
        } catch (err) {
          log.warn(`[memory] Conflict detection failed: ${errorMessage(err)}`);
        }
        return {
          content: [{ type: "text", text: `Saved semantic note: ${noteId}${conflictWarning}` + getShortReminder(threadId) }],
        };
      } catch (err) {
        return errorResult(`Memory save error: ${errorMessage(err)}` + getShortReminder(threadId));
      }
    }

    // ── memory_update ─────────────────────────────────────────────────────
    case "memory_update": {
      const threadId = resolveThreadId(args);
      try {
        const db = getMemoryDb();
        const memId = String(args.memoryId ?? "");
        const action = String(args.action ?? "update");
        const reason = String(args.reason ?? "");

        if (action === "supersede" && memId.startsWith("sn_")) {
          const origRow = db.prepare("SELECT type, keywords FROM semantic_notes WHERE note_id = ?").get(memId) as { type: string; keywords: string } | undefined;
          if (!origRow) {
            return errorResult(`Note ${memId} not found — cannot supersede a non-existent note.`);
          }
          const newContent = String(args.newContent ?? "");
          if (!newContent.trim()) return errorResult("Error: 'newContent' is required when superseding a note. The original note would be destroyed with no replacement.");
          const newId = supersedeNote(db, memId, {
            type: origRow.type as "fact" | "preference" | "pattern" | "entity" | "relationship",
            content: newContent,
            keywords: origRow.keywords ? JSON.parse(origRow.keywords) : [],
            confidence: typeof args.newConfidence === "number" ? args.newConfidence : 0.8,
            priority: typeof args.newPriority === "number" ? args.newPriority : undefined,
          });
          return {
            content: [{ type: "text", text: `Superseded ${memId} → ${newId} (reason: ${reason})` + getShortReminder(threadId) }],
          };
        }

        if (memId.startsWith("sn_")) {
          const updates: Record<string, unknown> = {};
          if (args.newContent) updates.content = String(args.newContent);
          if (typeof args.newConfidence === "number") updates.confidence = args.newConfidence;
          if (typeof args.newPriority === "number") updates.priority = args.newPriority;
          updateSemanticNote(db, memId, updates as Parameters<typeof updateSemanticNote>[2]);
          return {
            content: [{ type: "text", text: `Updated note ${memId} (reason: ${reason})` + getShortReminder(threadId) }],
          };
        }

        if (memId.startsWith("pr_")) {
          const updates: Record<string, unknown> = {};
          if (args.newContent) updates.description = String(args.newContent);
          if (typeof args.newConfidence === "number") updates.confidence = args.newConfidence;
          updateProcedure(db, memId, updates as Parameters<typeof updateProcedure>[2]);
          return {
            content: [{ type: "text", text: `Updated procedure ${memId} (reason: ${reason})` + getShortReminder(threadId) }],
          };
        }

        return errorResult(`Unknown memory ID format: ${memId}` + getShortReminder(threadId));
      } catch (err) {
        return errorResult(`Memory update error: ${errorMessage(err)}` + getShortReminder(threadId));
      }
    }

    // ── memory_consolidate ────────────────────────────────────────────────
    case "memory_consolidate": {
      const threadId = resolveThreadId(args);
      if (threadId === undefined) {
        return errorResult("Error: No active thread." + getShortReminder(undefined));
      }
      try {
        const db = getMemoryDb();
        const report = await runIntelligentConsolidation(db, threadId);
        ctx.onConsolidation?.(); // Prevent redundant auto-consolidation
        if (report.episodesProcessed === 0) {
          return {
            content: [{ type: "text", text: "No unconsolidated episodes. Memory is up to date." + getShortReminder(threadId) }],
          };
        }

        const reportLines = [
          "## Consolidation Report",
          `- Episodes processed: ${report.episodesProcessed}`,
          `- Notes created: ${report.notesCreated}`,
          `- Duration: ${report.durationMs}ms`,
        ];
        if (report.details.length > 0) {
          reportLines.push("", "### Extracted Knowledge");
          for (const d of report.details) {
            reportLines.push(`- ${d}`);
          }
        }

        return { content: [{ type: "text", text: reportLines.join("\n") + getShortReminder(threadId) }] };
      } catch (err) {
        return errorResult(`Consolidation error: ${errorMessage(err)}` + getShortReminder(threadId));
      }
    }

    // ── memory_status ─────────────────────────────────────────────────────
    case "memory_status": {
      const threadId = resolveThreadId(args);
      if (threadId === undefined) {
        return errorResult("Error: No active thread." + getShortReminder(undefined));
      }
      try {
        const db = getMemoryDb();
        const status = getMemoryStatus(db, threadId);
        const topics = getTopicIndex(db);

        const lines = [
          "## Memory Status",
          `- Episodes: ${status.totalEpisodes} (${status.unconsolidatedEpisodes} unconsolidated)`,
          `- Semantic notes: ${status.totalSemanticNotes}`,
          `- Procedures: ${status.totalProcedures}`,
          `- Voice signatures: ${status.totalVoiceSignatures}`,
          `- Last consolidation: ${status.lastConsolidation ?? "never"}`,
          `- DB size: ${(status.dbSizeBytes / 1024).toFixed(1)} KB`,
        ];

        if (topics.length > 0) {
          lines.push("", "**Topics:**");
          for (const t of topics.slice(0, 15)) {
            lines.push(`- ${t.topic} (${t.semanticCount} notes, ${t.proceduralCount} procs, conf: ${t.avgConfidence.toFixed(2)})`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") + getShortReminder(threadId) }] };
      } catch (err) {
        return errorResult(`Memory status error: ${errorMessage(err)}` + getShortReminder(threadId));
      }
    }

    // ── memory_forget ─────────────────────────────────────────────────────
    case "memory_forget": {
      const threadId = resolveThreadId(args);
      try {
        const db = getMemoryDb();
        const memId = String(args.memoryId ?? "");
        const reason = String(args.reason ?? "");
        const result = forgetMemory(db, memId, reason);
        if (!result.deleted) {
          return {
            content: [{ type: "text", text: `Memory ${memId} not found (layer: ${result.layer}). Nothing was deleted.` + getShortReminder(threadId) }],
          };
        }
        return {
          content: [{ type: "text", text: `Forgot ${result.layer} memory ${memId} (reason: ${reason})` + getShortReminder(threadId) }],
        };
      } catch (err) {
        return errorResult(`Memory forget error: ${errorMessage(err)}` + getShortReminder(threadId));
      }
    }

    default:
      return errorResult(`Unknown memory tool: ${name}`);
  }
}
