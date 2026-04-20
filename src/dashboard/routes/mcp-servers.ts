/**
 * Dashboard API — MCP servers CRUD route handlers.
 */

import { getMcpServers, addMcpServer, removeMcpServer, type McpServerConfig } from "../../config.js";
import { errorMessage } from "../../utils.js";
import { readBody, safeParseJSON, type RouteHandler } from "./types.js";

/** Allowlist config fields to prevent arbitrary property injection. */
function sanitizeMcpConfig(raw: Record<string, unknown>): McpServerConfig {
    if (raw.type === "stdio") {
        return {
            type: "stdio",
            command: String(raw.command ?? ""),
            ...(Array.isArray(raw.args) ? { args: raw.args.map(String) } : {}),
            ...(raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
                ? { env: Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) }
                : {}),
        };
    }
    return {
        type: "http",
        url: String(raw.url ?? ""),
        ...(raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
            ? { headers: Object.fromEntries(Object.entries(raw.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])) }
            : {}),
        ...(raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
            ? { env: Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) }
            : {}),
    };
}

/** GET /api/mcp-servers → { servers: Record<string, McpServerConfig> } */
export const handleGetMcpServers: RouteHandler = ({ json }) => {
    json({ servers: getMcpServers() });
    return true;
};

/** POST /api/mcp-servers → { name, config } → add/update */
export const handlePostMcpServer = (async ({ req, json }) => {
    const raw = await readBody(req);
    const body = safeParseJSON(raw);
    if (!body || typeof body !== "object") { json({ error: "Invalid JSON body" }, 400); return true; }
    const { name, config } = body as { name?: unknown; config?: unknown };
    if (typeof name !== "string" || !name.trim()) { json({ error: "name is required (non-empty string)" }, 400); return true; }
    if (!config || typeof config !== "object") { json({ error: "config object is required" }, 400); return true; }
    const cfg = config as Record<string, unknown>;
    if (cfg.type !== "stdio" && cfg.type !== "http") { json({ error: "config.type must be 'stdio' or 'http'" }, 400); return true; }

    try {
        addMcpServer(name.trim(), sanitizeMcpConfig(cfg));
        json({ ok: true, servers: getMcpServers() });
    } catch (err) {
        json({ error: errorMessage(err) }, 400);
    }
    return true;
}) satisfies (...args: Parameters<RouteHandler>) => Promise<boolean>;

/** DELETE /api/mcp-servers/:name → remove (name passed from router) */
export function handleDeleteMcpServer({ json }: Parameters<RouteHandler>[0], name: string): boolean {
    try {
        const decoded = decodeURIComponent(name);
        const existed = removeMcpServer(decoded);
        json({ ok: true, existed, servers: getMcpServers() });
    } catch {
        json({ error: "Invalid server name" }, 400);
    }
    return true;
}
