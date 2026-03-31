/**
 * Dashboard API — template-related route handlers.
 * Covers: reminders template, drive template, drive presets, named template CRUD.
 */

import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getEffectiveAgentType, type AgentType } from "../../config.js";
import { DEFAULT_DRIVE_PROMPT, loadDrivePresets, getDefaultRemindersTemplate } from "../presets.js";
import { readBody, type RouteHandler, type RouteArgs } from "./types.js";

const AGENT_TYPES: AgentType[] = ["copilot", "copilot_claude", "copilot_codex", "claude", "cursor", "codex", "openai_codex"];

// ─── GET /api/templates — list reminders template + agent-specific overrides ─

export const handleGetTemplates: RouteHandler = ({ json }) => {
    void (async () => {
        try {
            const templatesDir = join(homedir(), ".remote-copilot-mcp", "templates");

            // Base reminders template
            const userFile = join(templatesDir, "reminders.md");
            let content: string;
            let isDefault = false;
            try {
                content = await readFile(userFile, "utf-8");
            } catch {
                content = getDefaultRemindersTemplate(getEffectiveAgentType());
                isDefault = true;
            }

            // Agent-specific reminder suffixes
            const agentReminders: Record<string, { content: string; isDefault: boolean }> = {};
            for (const agent of AGENT_TYPES) {
                const agentFile = join(templatesDir, `reminders-${agent}.md`);
                try {
                    agentReminders[agent] = { content: await readFile(agentFile, "utf-8"), isDefault: false };
                } catch {
                    agentReminders[agent] = { content: "", isDefault: true };
                }
            }

            json({ templates: [{ name: "reminders", content, isDefault }], agentReminders });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
};

// ─── GET /api/templates/drive — drive template with default ─────────────────

export const handleGetDriveTemplate: RouteHandler = ({ json }) => {
    void (async () => {
        try {
            const templatesDir = join(homedir(), ".remote-copilot-mcp", "templates");
            const userFile = join(templatesDir, "drive.md");
            let custom: string | null = null;
            try {
                custom = await readFile(userFile, "utf-8");
            } catch {
                custom = null;
            }
            json({ custom, default: DEFAULT_DRIVE_PROMPT });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
};

// ─── GET /api/templates/drive-presets — available drive presets ──────────────

export const handleGetDrivePresets: RouteHandler = ({ json }) => {
    void (async () => {
        try {
            const presets = await loadDrivePresets();
            json({ presets });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
};

// ─── POST/DELETE /api/templates/:name — dynamic template CRUD ───────────────

/**
 * Handle POST (save) or DELETE (remove) for a named template.
 * Returns true if handled, false if the HTTP method is not POST/DELETE.
 */
export function handleTemplateCrud(args: RouteArgs, name: string): boolean {
    const { req, json } = args;

    if (req.method === "POST") {
        void (async () => {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body) as { content?: string };
                if (typeof parsed.content !== "string") {
                    json({ error: "Missing content field" }, 400);
                    return;
                }
                const templatesDir = join(homedir(), ".remote-copilot-mcp", "templates");
                await mkdir(templatesDir, { recursive: true });
                await writeFile(join(templatesDir, `${name}.md`), parsed.content, "utf-8");
                json({ ok: true });
            } catch (err) {
                json({ error: err instanceof Error ? err.message : String(err) }, 500);
            }
        })();
        return true;
    }

    if (req.method === "DELETE") {
        void (async () => {
            try {
                const templatesDir = join(homedir(), ".remote-copilot-mcp", "templates");
                try { await unlink(join(templatesDir, `${name}.md`)); } catch { /* ok if missing */ }
                json({ ok: true });
            } catch (err) {
                json({ error: err instanceof Error ? err.message : String(err) }, 500);
            }
        })();
        return true;
    }

    return false;
}
