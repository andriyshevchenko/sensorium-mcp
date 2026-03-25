/**
 * Dashboard API — settings-related route handlers.
 * Covers: agent-type, dmn-activation-hours, claude-mcp-config, thread-agent-types.
 */

import {
    getAgentType,
    setAgentType,
    setThreadAgentType,
    getAllThreadAgentTypes,
    getClaudeMcpConfigPath,
    setClaudeMcpConfigPath,
    getGuardrailsEnabled,
    setGuardrailsEnabled,
    type AgentType,
} from "../../config.js";

import { readBody, type RouteHandler } from "./types.js";

// ─── DMN activation hours ───────────────────────────────────────────────────

export const handleGetDmnActivationHours: RouteHandler = ({ json }) => {
    const rawVal = parseFloat(process.env.DMN_ACTIVATION_HOURS ?? "");
    json({ value: Math.max(0.5, Number.isFinite(rawVal) ? rawVal : 4) });
    return true;
};

// ─── Claude MCP config path ─────────────────────────────────────────────────

export const handleGetClaudeMcpConfig: RouteHandler = ({ json }) => {
    json({ path: getClaudeMcpConfigPath() });
    return true;
};

export const handlePostClaudeMcpConfig: RouteHandler = ({ req, json }) => {
    void (async () => {
        try {
            const body = await readBody(req);
            const parsed = JSON.parse(body) as { path?: string };
            if (typeof parsed.path !== "string" || !parsed.path.trim()) {
                json({ error: "Missing or empty path" }, 400);
                return;
            }
            setClaudeMcpConfigPath(parsed.path.trim());
            json({ ok: true, path: parsed.path.trim() });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
};

// ─── Global agent type ──────────────────────────────────────────────────────

export const handleGetAgentType: RouteHandler = ({ json }) => {
    json({ agentType: getAgentType() });
    return true;
};

export const handlePostAgentType: RouteHandler = ({ req, json }) => {
    void (async () => {
        try {
            const body = await readBody(req);
            const parsed = JSON.parse(body) as { agentType?: string };
            const valid = ["copilot", "claude", "cursor"];
            if (!parsed.agentType || !valid.includes(parsed.agentType)) {
                json({ error: "Invalid agent type. Must be: copilot, claude, cursor" }, 400);
                return;
            }
            setAgentType(parsed.agentType as AgentType);
            json({ ok: true, agentType: parsed.agentType });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
};

// ─── Per-thread agent-type overrides ────────────────────────────────────────

export const handleGetThreadAgentTypes: RouteHandler = ({ json }) => {
    json({ threadAgentTypes: getAllThreadAgentTypes() });
    return true;
};

export const handlePostThreadAgentType: RouteHandler = ({ req, json }) => {
    void (async () => {
        try {
            const body = await readBody(req);
            const parsed = JSON.parse(body) as { threadId?: number; agentType?: string };
            const valid = ["copilot", "claude", "cursor"];
            if (parsed.threadId == null || !Number.isFinite(parsed.threadId)) {
                json({ error: "Missing or invalid threadId (must be a number)" }, 400);
                return;
            }
            if (!parsed.agentType || !valid.includes(parsed.agentType)) {
                json({ error: "Invalid agent type. Must be: copilot, claude, cursor" }, 400);
                return;
            }
            setThreadAgentType(parsed.threadId, parsed.agentType as AgentType);
            json({ ok: true, threadId: parsed.threadId, agentType: parsed.agentType });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
};

// ─── Guardrails enabled toggle ──────────────────────────────────────────────

export const handleGetGuardrailsEnabled: RouteHandler = ({ json }) => {
    json({ enabled: getGuardrailsEnabled() });
    return true;
};

export const handlePostGuardrailsEnabled: RouteHandler = ({ req, json }) => {
    void (async () => {
        try {
            const body = await readBody(req);
            const parsed = JSON.parse(body) as { enabled?: boolean };
            if (typeof parsed.enabled !== "boolean") {
                json({ error: "Missing or invalid 'enabled' (must be a boolean)" }, 400);
                return;
            }
            setGuardrailsEnabled(parsed.enabled);
            json({ ok: true, enabled: parsed.enabled });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
};
