/**
 * Skill tool definitions — search_skills, get_skill.
 */

import type { ToolDefinition } from "../definitions.js";

export const skillToolDefs: ToolDefinition[] = [
  {
    name: "search_skills",
    description:
      "Search available skills by name or keyword. Returns a list of skill names with descriptions. " +
      "Call this to discover which skills are available before loading one.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional search filter — matches against skill names and trigger phrases. Omit to list all skills.",
        },
      },
    },
  },
  {
    name: "get_skill",
    description:
      "Load the full content of a skill by name. Use this to inject skill instructions into your context " +
      "before executing a task that requires specialized behavior (e.g., code review, clean code, orchestrator).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "The skill name to load (case-insensitive). Use search_skills first to discover available names.",
        },
      },
      required: ["name"],
    },
  },
];
