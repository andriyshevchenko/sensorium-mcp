import {
  getBootstrapContext,
  getCompactRefreshNotes,
  MAX_BOOTSTRAP_CONVERSATION_CHARS,
  MAX_MESSAGE_CONTENT_CHARS,
} from "../data/memory/bootstrap.js";
import { parseReflectionFields } from "../data/memory/reflection.js";
import type { Database } from "../data/memory/schema.js";

function formatReflection(content: string): string {
  // Parse structured reflection format using shared parser
  const typeMatch = content.match(/^\[REFLECTION\]\s*(\[[\w\s]+\])\s*(\[[\w\s]+\])/);
  const fields = parseReflectionFields(content);

  if (fields) {
    const prefix = typeMatch ? `${typeMatch[1]} ${typeMatch[2]} ` : "";
    const decisionTrimmed = fields.decision.slice(0, 100);
    const decisionText = fields.decision.length > 100 ? `${decisionTrimmed}...` : decisionTrimmed;
    const lessonTruncated = fields.lesson.slice(0, 300);
    const lessonText = fields.lesson.length > 300 ? `${lessonTruncated}...` : lessonTruncated;
    return `${prefix}Decision: ${decisionText} **Lesson:** ${lessonText}`;
  }

  // Fallback for older reflections
  return content.slice(0, 500);
}

export function assembleBootstrap(db: Database, threadId: number, memorySourceThreadId?: number): string {
  const context = getBootstrapContext(db, threadId, memorySourceThreadId);
  const lines: string[] = [];

  if (context.identityPrompt) {
    lines.push(context.identityPrompt);
    lines.push("");
  }

  lines.push("# Memory Briefing");
  if (memorySourceThreadId !== undefined) {
    lines.push(`> **Ghost thread** — memory sourced from parent thread ${memorySourceThreadId}. Runtime memory ops use thread ${threadId}.`);
    if (
      context.recentEpisodes.length === 0
      && context.pinnedNotes.length === 0
      && context.keyKnowledge.length === 0
      && context.procedures.length === 0
    ) {
      lines.push(`> ⚠️ No memory found for source thread ${memorySourceThreadId}. The ghost thread will start without parent context.`);
    }
  }
  lines.push("");

  if (context.recentEpisodes.length > 0) {
    lines.push("## Recent Conversation");
    const conversationLines: string[] = [];
    let totalChars = 0;

    for (const episode of context.recentEpisodes) {
      const raw = typeof episode.content === "object" && episode.content !== null
        ? (episode.content.text ?? episode.content.caption ?? null)
        : null;
      const fullText = typeof raw === "string" ? raw : JSON.stringify(episode.content);
      const textContent = fullText.length > MAX_MESSAGE_CONTENT_CHARS
        ? fullText.slice(0, MAX_MESSAGE_CONTENT_CHARS) + "…"
        : fullText;

      let line: string;
      if (episode.type === "operator_message") {
        line = `**Operator** (${episode.timestamp}): ${textContent}`;
      } else if (episode.type === "agent_action") {
        line = `**You** (${episode.timestamp}): ${textContent}`;
      } else {
        line = `[${episode.type}] ${textContent} (${episode.timestamp})`;
      }

      totalChars += line.length;
      conversationLines.push(line);
    }

    while (totalChars > MAX_BOOTSTRAP_CONVERSATION_CHARS && conversationLines.length > 1) {
      const removed = conversationLines.shift()!;
      totalChars -= removed.length;
    }

    lines.push(...conversationLines);
    lines.push("");
  }

  if (context.guardrails.length > 0) {
    lines.push("## Active Decisions (always enforced)");
    for (const guardrail of context.guardrails) {
      const line = guardrail.content.length > 120 ? guardrail.content.slice(0, 117) + "..." : guardrail.content;
      lines.push(`- ${line}`);
    }
    lines.push("");
  }

  if (context.narratives) {
    lines.push("## Temporal Context");
    if (context.narratives.half_year) {
      lines.push("### This Half-Year");
      lines.push(context.narratives.half_year);
      lines.push("");
    }
    if (context.narratives.quarter) {
      lines.push("### This Quarter");
      lines.push(context.narratives.quarter);
      lines.push("");
    }
    if (context.narratives.month) {
      lines.push("### This Month");
      lines.push(context.narratives.month);
      lines.push("");
    }
    if (context.narratives.week) {
      lines.push("### This Week");
      lines.push(context.narratives.week);
      lines.push("");
    }
    if (context.narratives.day) {
      lines.push("### Today");
      lines.push(context.narratives.day);
      lines.push("");
    }
  }

  if (context.pinnedNotes.length > 0) {
    lines.push("## Pinned (Long-Term Context)");
    for (const note of context.pinnedNotes) {
      lines.push(`- **[${note.type}]** ${note.content} _(conf: ${note.confidence.toFixed(2)})_`);
    }
    lines.push("");
  }

  if (context.keyKnowledge.length > 0) {
    lines.push("## Key Knowledge");
    for (const note of context.keyKnowledge) {
      lines.push(`- **[${note.type}]** ${note.content} (conf: ${note.confidence.toFixed(2)}, accessed: ${note.accessCount}x)`);
    }
    lines.push("");
  }

  if (context.procedures.length > 0) {
    lines.push("## Active Procedures");
    for (const procedure of context.procedures) {
      lines.push(`- **${procedure.name}** (${procedure.type}) — success: ${(procedure.successRate * 100).toFixed(0)}%, used ${procedure.timesExecuted}x`);
      if (procedure.steps.length > 0) {
        lines.push(`  Steps: ${procedure.steps.join(" → ")}`);
      }
    }
    lines.push("");
  }

  if (context.baseline && context.baseline.sampleCount > 0) {
    lines.push("## Operator Voice Profile");
    const parts: string[] = [`${context.baseline.sampleCount} samples`];
    if (context.baseline.avgValence !== null) parts.push(`valence ${context.baseline.avgValence.toFixed(2)}`);
    if (context.baseline.avgArousal !== null) parts.push(`arousal ${context.baseline.avgArousal.toFixed(2)}`);
    if (context.baseline.avgSpeechRate !== null) parts.push(`speech rate ${context.baseline.avgSpeechRate.toFixed(1)}`);
    lines.push(parts.join(" · "));
    lines.push("");
  }

  if (context.reflections.length > 0) {
    lines.push("## Recent Reflections");
    for (const reflection of context.reflections) {
      lines.push(`- ${formatReflection(reflection.content)} _(conf: ${reflection.confidence.toFixed(2)}, ${reflection.createdAt.slice(0, 10)})_`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function assembleCompactRefresh(db: Database, threadId: number): string {
  const topNotes = getCompactRefreshNotes(db, threadId);
  if (topNotes.length === 0) return "";

  const lines = ["## Memory Refresh"];
  for (const note of topNotes) {
    lines.push(`- **[${note.type}]** ${note.content}`);
  }
  return lines.join("\n");
}
