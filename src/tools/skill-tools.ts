/**
 * Skill tool handlers — search_skills, get_skill.
 */

import { loadSkills } from "../intent.js";
import type { ToolResult } from "../types.js";

export function handleSearchSkills(args: Record<string, unknown>): ToolResult {
  const query = typeof args.query === "string" ? args.query.toLowerCase().trim() : "";
  const skills = loadSkills();

  const filtered = query
    ? skills.filter(s =>
        s.name.toLowerCase().includes(query) ||
        s.triggers.some(t => t.toLowerCase().includes(query))
      )
    : skills;

  if (filtered.length === 0) {
    return {
      content: [{ type: "text", text: query ? `No skills found matching "${query}".` : "No skills available." }],
    };
  }

  const lines = filtered.map(s =>
    `- **${s.name}** — triggers: ${s.triggers.join(", ")} (source: ${s.source})`
  );

  return {
    content: [{ type: "text", text: `## Available Skills\n\n${lines.join("\n")}` }],
  };
}

export function handleGetSkill(args: Record<string, unknown>): ToolResult {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return {
      content: [{ type: "text", text: "Error: skill name is required." }],
      isError: true,
    };
  }

  const skills = loadSkills();
  const skill = skills.find(s => s.name.toLowerCase() === name.toLowerCase());

  if (!skill) {
    const available = skills.map(s => s.name).join(", ");
    return {
      content: [{ type: "text", text: `Skill "${name}" not found. Available: ${available}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `[Skill: ${skill.name}]\n\n${skill.content}` }],
  };
}
