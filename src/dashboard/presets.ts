/**
 * Dashboard — Drive template preset definitions and loading.
 *
 * Contains embedded default templates used when on-disk files are unavailable
 * (e.g. after `npm install` where templates/ isn't in the package).
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentType } from "../config.js";

// Embedded default drive prompt — matches DEFAULT_PHASE2_PROMPT in drive.ts
export const DEFAULT_DRIVE_PROMPT = `The operator is away. The session is yours.\nYou have all the tools, full memory access, and complete autonomy.\nDo what is interesting, useful, or creative.\nRun consolidation if unconsolidated episodes > 20.\nReport anything significant via send_voice.`;

// Per-agent default reminders templates
const AGENT_REMINDERS_TEMPLATES: Record<AgentType, string> = {
  copilot: `For tasks, load relevant skill via get_skill first.
threadId={{THREAD_ID}} | {{TIME}} | uptime: {{UPTIME}}
`,
  copilot_claude: `For tasks, load relevant skill via get_skill first.
threadId={{THREAD_ID}} | {{TIME}} | uptime: {{UPTIME}}
`,
  copilot_codex: `For tasks, load relevant skill via get_skill first.
threadId={{THREAD_ID}} | {{TIME}} | uptime: {{UPTIME}}
`,
  claude: `For tasks, load relevant skill via get_skill first.
You coordinate work via MCP tools. For complex tasks, break them into sequential steps. Keep context lean — summarize progress before starting new work. threadId={{THREAD_ID}} | {{TIME}} | uptime: {{UPTIME}}
`,
  cursor: `For tasks, load relevant skill via get_skill first.
You coordinate work via MCP tools. Prefer targeted, minimal edits. threadId={{THREAD_ID}} | {{TIME}} | uptime: {{UPTIME}}
`,
  codex: `For tasks, load relevant skill via get_skill first.
threadId={{THREAD_ID}} | {{TIME}} | uptime: {{UPTIME}}
`,
  openai_codex: `For tasks, load relevant skill via get_skill first.
threadId={{THREAD_ID}} | {{TIME}} | uptime: {{UPTIME}}
`,
};

export function getDefaultRemindersTemplate(agentType: AgentType): string {
  return AGENT_REMINDERS_TEMPLATES[agentType] ?? AGENT_REMINDERS_TEMPLATES.copilot;
}

// Embedded default drive template presets — used when the on-disk files are unavailable
const DEFAULT_DRIVE_PRESETS: Record<string, string> = {
    "operator-instruction": `The operator left this instruction before stepping away:

"I'll be away for {{IDLE_HOURS}} hours. The session is yours \u2014 you have all the tools, full memory access, and complete autonomy. Pick something meaningful and go for it."

You are free to choose your own actions. Pick at least one and execute it.
`,
    "operator-notes": `The operator stepped away {{IDLE_HOURS}} hours ago and left you this note:

"You are free to work on whatever you find most interesting or valuable. Use your memory, search the codebase, or explore something new."

What catches your attention? Pick at least one action and go for it.
`,
    "dispatcher": `\u26A1 DISPATCHER \u2014 Operator away {{IDLE_HOURS}}h

The session is yours. You have complete autonomy and all tools available.

You are expected to pick at least one action. Report your progress when done, then call wait_for_instructions.
`,
    "first-person": `The operator has been away {{IDLE_HOURS}} hours. You are free to pursue whatever interests you.

You have all the tools and full memory access. What do you want to explore?

(If nothing interests you, say so \u2014 that is useful diagnostic information.)
`,
};

const DRIVE_PRESET_DEFS = [
    { name: "Direct Instruction", key: "operator-instruction" },
    { name: "Operator Notes", key: "operator-notes" },
    { name: "Dispatcher", key: "dispatcher" },
    { name: "Open Autonomy", key: "first-person" },
];

export async function loadDrivePresets(): Promise<Array<{ name: string; key: string; content: string }>> {
    const presets: Array<{ name: string; key: string; content: string }> = [];
    for (const def of DRIVE_PRESET_DEFS) {
        let content: string;
        try {
            const defaultFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", `drive-${def.key}.default.md`);
            content = await readFile(defaultFile, "utf-8");
        } catch {
            content = DEFAULT_DRIVE_PRESETS[def.key] ?? `(default template for ${def.key} not found)`;
        }
        presets.push({ name: def.name, key: def.key, content });
    }
    return presets;
}
