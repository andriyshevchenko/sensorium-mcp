/**
 * Dashboard — Drive template preset definitions and loading.
 *
 * Contains embedded default templates used when on-disk files are unavailable
 * (e.g. after `npm install` where templates/ isn't in the package).
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Embedded default template — used when the file-system copy is unavailable
// (e.g. after `npm install` where templates/ isn't in the package).
export const DEFAULT_REMINDERS_TEMPLATE = `<!-- 
  Default reminders template for remote-copilot-mcp.
  
  Copy this file to ~/.remote-copilot-mcp/templates/reminders.md to activate.
  Customize the text as needed — the hardcoded fallback will no longer be used
  once the template file exists.

  Supported variables (replaced at render time):
    {{OPERATOR_MESSAGE}}  — the operator's latest message text (may be empty)
    {{THREAD_ID}}         — current Telegram thread ID (or "?" if unset)
    {{TIME}}              — formatted timestamp, e.g. "21 Mar 2026, 14:05 GMT"
    {{UPTIME}}            — session uptime string, e.g. "12m"
    {{VERSION}}           — package version from package.json
    {{MODE}}              — "autonomous" or "standard"
-->

You are the ORCHESTRATOR. Your only permitted actions: plan, decide, call wait_for_instructions/hibernate/send_voice/report_progress/memory tools. ALL other work (file reads, edits, searches, code changes) MUST go through runSubagent. Non-negotiable. threadId={{THREAD_ID}} | {{TIME}} | uptime: {{UPTIME}}
`;

// Embedded default drive template presets — used when the on-disk files are unavailable
export const DEFAULT_DRIVE_PRESETS: Record<string, string> = {
    "operator-instruction": `The operator left this instruction before stepping away:

"I'll be away for {{IDLE_HOURS}} hours. The session is yours \u2014 you have all the tools, full memory access, and complete autonomy. Pick something meaningful and go for it."

What do you want to do? Pick at least one action and execute it.
`,
    "operator-notes": `The operator stepped away {{IDLE_HOURS}} hours ago and left you this note:

"You're free to work on whatever you find most interesting or valuable. Use your memory, search the codebase, or explore something new."

What catches your attention? Pick at least one action and go for it.
`,
    "dispatcher": `\u26A1 DISPATCHER \u2014 Operator away {{IDLE_HOURS}}h

The session is yours. You have complete autonomy and all tools available.

What do you want to do? Pick at least one action. Report progress when done, then call wait_for_instructions.
`,
    "first-person": `The operator has been away {{IDLE_HOURS}} hours. I'm free to pursue whatever interests me.

I have all the tools and full memory access. What should I explore?

(If nothing interests me, I should say so \u2014 that's useful diagnostic information.)
`,
};

export const DRIVE_PRESET_DEFS = [
    { name: "Direct Instruction", key: "operator-instruction" },
    { name: "Operator Notes", key: "operator-notes" },
    { name: "Dispatcher", key: "dispatcher" },
    { name: "First Person", key: "first-person" },
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
