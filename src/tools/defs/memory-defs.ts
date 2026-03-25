/**
 * Memory tool definitions — memory_search, memory_save, memory_update,
 * memory_consolidate, memory_status, memory_forget.
 */

import type { ToolDefinition } from "../definitions.js";

export const memoryToolDefs: ToolDefinition[] = [
  {
    name: "memory_search",
    description:
      "Search across all memory layers for relevant information. " +
      "Use BEFORE starting any task to recall facts, preferences, past events, or procedures. " +
      "Returns ranked results with source layer. Do NOT use for info already in your bootstrap briefing.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query.",
        },
        layers: {
          type: "array",
          items: { type: "string" },
          description: 'Filter layers: ["episodic", "semantic", "procedural"]. Default: all.',
        },
        types: {
          type: "array",
          items: { type: "string" },
          description: 'Filter by type: ["fact", "preference", "pattern", "workflow", ...].',
        },
        threadId: {
          type: "number",
          description: "Active thread ID.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_save",
    description:
      "Save a piece of knowledge to semantic memory (Layer 3). " +
      "Use when you learn something important that should persist across sessions: " +
      "operator preferences, corrections, facts, patterns. " +
      "Do NOT use for routine conversation \u2014 episodic memory captures that automatically.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The fact/preference/pattern in one clear sentence.",
        },
        type: {
          type: "string",
          description: '"fact" | "preference" | "pattern" | "entity" | "relationship".',
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "3-7 keywords for retrieval.",
        },
        confidence: {
          type: "number",
          description: "0.0-1.0. Default: 0.8.",
        },
        priority: {
          type: "number",
          description: "0=normal, 1=notable, 2=high importance. Infer from operator's emotional investment: 'important'/'I really need' \u2192 2, 'would be nice'/'should' \u2192 1, else 0.",
        },
        guardrail: {
          type: "boolean",
          description: "Set true to mark as an always-enforced guardrail constraint (e.g. \"NEVER do X\", \"ALWAYS do Y\"). Only for critical decision rules.",
        },
        threadId: {
          type: "number",
          description: "Active thread ID.",
        },
      },
      required: ["content", "type", "keywords"],
    },
  },
  {
    name: "memory_update",
    description:
      "Update or supersede an existing semantic note or procedure. " +
      "Use when operator corrects stored information or when facts have changed.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: {
          type: "string",
          description: "note_id or procedure_id to update.",
        },
        action: {
          type: "string",
          description: '"update" (modify in place) | "supersede" (expire old, create new).',
        },
        newContent: {
          type: "string",
          description: "New content (required for supersede, optional for update).",
        },
        newConfidence: {
          type: "number",
          description: "Updated confidence score.",
        },
        newPriority: {
          type: "number",
          description: "Updated priority: 0=normal, 1=notable, 2=high importance.",
        },
        reason: {
          type: "string",
          description: "Why this is being updated.",
        },
        threadId: {
          type: "number",
          description: "Active thread ID.",
        },
      },
      required: ["memoryId", "action", "reason"],
    },
  },
  {
    name: "memory_consolidate",
    description:
      "Run memory consolidation cycle (sleep process). Normally triggered automatically during idle. " +
      "Manually call if memory_status shows many unconsolidated episodes.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "number",
          description: "Active thread ID.",
        },
      },
    },
  },
  {
    name: "memory_status",
    description:
      "Get memory system health and statistics. Lightweight (~300 tokens). " +
      "Use when unsure if you have relevant memories, to check if consolidation is needed, " +
      "or to report memory state to operator.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "number",
          description: "Active thread ID.",
        },
      },
    },
  },
  {
    name: "memory_forget",
    description:
      "Mark a memory as expired/forgotten. Use sparingly \u2014 most forgetting happens via decay. " +
      "Use when operator explicitly asks to forget something or info is confirmed wrong.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: {
          type: "string",
          description: "note_id, procedure_id, or episode_id to forget.",
        },
        reason: {
          type: "string",
          description: "Why this is being forgotten.",
        },
        threadId: {
          type: "number",
          description: "Active thread ID.",
        },
      },
      required: ["memoryId", "reason"],
    },
  },
];
