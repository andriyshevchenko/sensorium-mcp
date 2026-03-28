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
    getBootstrapMessageCount,
    setBootstrapMessageCount,
    getKeepAliveEnabled,
    setKeepAliveEnabled,
    getKeepAliveThreadId,
    setKeepAliveThreadId,
    getKeepAliveMaxRetries,
    setKeepAliveMaxRetries,
    getKeepAliveCooldownMs,
    setKeepAliveCooldownMs,
    type AgentType,
} from "../../config.js";

import { readBody, safeParseJSON, type RouteHandler } from "./types.js";

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

// ─── Bootstrap message count ────────────────────────────────────────────────

export const handleGetBootstrapMessageCount: RouteHandler = ({ json }) => {
    json({ count: getBootstrapMessageCount() });
    return true;
};

export const handlePostBootstrapMessageCount: RouteHandler = ({ req, json }) => {
    void (async () => {
        try {
            const raw = await readBody(req);
            const body = safeParseJSON(raw) as Record<string, unknown> | null;
            const count = body && typeof body === "object" ? body.count : undefined;
            if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
                json({ error: "count must be a non-negative number" }, 400);
                return;
            }
            setBootstrapMessageCount(count);
            json({ ok: true, count: getBootstrapMessageCount() });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
};

// ─── Keep-alive settings ─────────────────────────────────────────────────────

export const handleGetKeepAlive: RouteHandler = ({ json }) => {
    json({
        keepAliveEnabled: getKeepAliveEnabled(),
        keepAliveThreadId: getKeepAliveThreadId(),
        keepAliveMaxRetries: getKeepAliveMaxRetries(),
        keepAliveCooldownMs: getKeepAliveCooldownMs(),
    });
    return true;
};

export const handlePostKeepAlive: RouteHandler = ({ req, json }) => {
    void (async () => {
        try {
            const raw = await readBody(req);
            const body = safeParseJSON(raw) as Record<string, unknown> | null;
            if (!body || typeof body !== "object") {
                json({ error: "Invalid request body" }, 400);
                return;
            }
            if ("keepAliveEnabled" in body) {
                if (typeof body.keepAliveEnabled !== "boolean") {
                    json({ error: "keepAliveEnabled must be a boolean" }, 400);
                    return;
                }
                setKeepAliveEnabled(body.keepAliveEnabled);
            }
            if ("keepAliveThreadId" in body) {
                const tid = body.keepAliveThreadId;
                if (typeof tid !== "number" || !Number.isFinite(tid) || tid < 0) {
                    json({ error: "keepAliveThreadId must be a non-negative number" }, 400);
                    return;
                }
                setKeepAliveThreadId(tid);
            }
            if ("keepAliveMaxRetries" in body) {
                const r = body.keepAliveMaxRetries;
                if (typeof r !== "number" || !Number.isFinite(r) || r < 1) {
                    json({ error: "keepAliveMaxRetries must be a positive number" }, 400);
                    return;
                }
                setKeepAliveMaxRetries(r);
            }
            if ("keepAliveCooldownMs" in body) {
                const ms = body.keepAliveCooldownMs;
                if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 1000) {
                    json({ error: "keepAliveCooldownMs must be >= 1000" }, 400);
                    return;
                }
                setKeepAliveCooldownMs(ms);
            }
            json({
                ok: true,
                keepAliveEnabled: getKeepAliveEnabled(),
                keepAliveThreadId: getKeepAliveThreadId(),
                keepAliveMaxRetries: getKeepAliveMaxRetries(),
                keepAliveCooldownMs: getKeepAliveCooldownMs(),
            });
        } catch (err) {
            json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    })();
    return true;
};
