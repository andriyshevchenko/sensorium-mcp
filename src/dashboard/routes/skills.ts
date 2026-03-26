/**
 * Dashboard API — skill-related route handlers.
 * Covers: listing loaded skills, saving user skill overrides.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadSkills, invalidateSkillCache } from "../../intent.js";
import { readBody, type RouteHandler, type RouteArgs } from "./types.js";

const MAX_SKILL_BODY_BYTES = 64 * 1024; // 64 KB

// ─── GET /api/skills — list all loaded skills ─────────────────────────────

export const handleGetSkills: RouteHandler = ({ json }) => {
    const skills = loadSkills();
    json({
        skills: skills.map(s => ({
            name: s.name,
            triggers: s.triggers,
            replacesOrchestrator: s.replacesOrchestrator,
            source: s.source,
            content: s.content,
        })),
    });
    return true;
};

// ─── PUT /api/skills/:name — save a user skill override ───────────────────
// NOTE: This handler is registered as a dynamic route in routes.ts dispatchApiRoute
// rather than in the static route table, because the route contains a :name parameter.

export async function handleSkillPut(args: RouteArgs, name: string): Promise<boolean> {
    const { req, json } = args;
    if (req.method !== "PUT") return false;

    try {
        // M3: Enforce body size limit (64 KB)
        const contentLength = parseInt(req.headers["content-length"] ?? "", 10);
        if (contentLength > MAX_SKILL_BODY_BYTES) {
            json({ error: `Body too large (limit ${MAX_SKILL_BODY_BYTES} bytes)` }, 413);
            return true;
        }
        const body = await readBody(req);
        if (Buffer.byteLength(body) > MAX_SKILL_BODY_BYTES) {
            json({ error: `Body too large (limit ${MAX_SKILL_BODY_BYTES} bytes)` }, 413);
            return true;
        }
        const parsed = JSON.parse(body) as { content?: string };
        if (typeof parsed.content !== "string") {
            json({ error: "Missing content field" }, 400);
            return true;
        }
        const skillsDir = join(homedir(), ".remote-copilot-mcp", "skills");
        await mkdir(skillsDir, { recursive: true });
        await writeFile(join(skillsDir, `${name}.md`), parsed.content, "utf-8");
        invalidateSkillCache();
        json({ ok: true });
    } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    return true;
}