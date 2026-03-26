/**
 * Dashboard API — skill-related route handlers.
 * Covers: listing loaded skills, saving user skill overrides.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadSkills } from "../../intent.js";
import { readBody, type RouteHandler, type RouteArgs } from "./types.js";

// ─── GET /api/skills — list all loaded skills ─────────────────────────────

export const handleGetSkills: RouteHandler = ({ json }) => {
    const skills = loadSkills();
    json({
        skills: skills.map(s => ({
            name: s.name,
            triggers: s.triggers,
            replacesOrchestrator: s.replacesOrchestrator,
            source: s.source,
        })),
    });
    return true;
};

// ─── PUT /api/skills/:name — save a user skill override ───────────────────

export function handleSkillPut(args: RouteArgs, name: string): boolean {
    const { req, json } = args;
    if (req.method !== "PUT") return false;

    void (async () => {
        try {
            const body = await readBody(req);
            const parsed = JSON.parse(body) as { content?: string };
            if (typeof parsed.content !== "string") {
                json({ error: "Missing content field" }, 400);
                return;
            }
            const skillsDir = join(homedir(), ".remote-copilot-mcp", "skills");
            await mkdir(skillsDir, { recursive: true });
            await writeFile(join(skillsDir, `${name}.md`), parsed.content, "utf-8");
            json({ ok: true });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
}
