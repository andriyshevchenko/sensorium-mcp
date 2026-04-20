/**
 * Unified MCP config generation for all agent types.
 *
 * Reads the canonical `mcpServers` from settings.json, injects the
 * sensorium-mcp entry, and formats for each agent's native config format.
 *
 * All builders take a `SensoriumTransport` param — the caller (agent-spawn)
 * is responsible for reading env vars and gating on port availability.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMcpServers, type McpServerConfig } from "../config.js";
import { PROCESS_PIDS_DIR } from "./process.service.js";

// ── Shared types ────────────────────────────────────────────────────────────

export interface SensoriumTransport {
  httpPort: number;
  secret: string | null;
}

// ── Shared JSON formatter (Claude & Copilot use the same schema) ────────────

function formatJsonMcpEntry(cfg: McpServerConfig): Record<string, unknown> {
  if (cfg.type === "stdio") {
    const entry: Record<string, unknown> = { command: cfg.command, args: cfg.args ?? [] };
    if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = cfg.env;
    return entry;
  }
  const entry: Record<string, unknown> = { type: "http", url: cfg.url };
  if (cfg.headers && Object.keys(cfg.headers).length > 0) entry.headers = cfg.headers;
  return entry;
}

function buildSensoriumJsonEntry(transport: SensoriumTransport, extras?: Record<string, unknown>): Record<string, unknown> {
  const entry: Record<string, unknown> = { type: "http", url: `http://127.0.0.1:${transport.httpPort}/mcp`, ...extras };
  if (transport.secret) entry.headers = { Authorization: `Bearer ${transport.secret}` };
  return entry;
}

// ── Claude format ───────────────────────────────────────────────────────────

/**
 * Generates a per-thread Claude MCP config file and returns the path.
 *
 * Format: `{ "mcpServers": { "<name>": { "type": "http"|"stdio", ... } } }`
 */
export function buildClaudeMcpConfig(transport: SensoriumTransport, threadId: number): string {
  const servers: Record<string, Record<string, unknown>> = {};
  servers["sensorium-mcp"] = buildSensoriumJsonEntry(transport);

  for (const [name, cfg] of Object.entries(getMcpServers())) {
    servers[name] = formatJsonMcpEntry(cfg);
  }

  const outPath = join(PROCESS_PIDS_DIR, `${threadId}-mcp-config.json`);
  mkdirSync(PROCESS_PIDS_DIR, { recursive: true });
  writeFileSync(outPath, JSON.stringify({ mcpServers: servers }, null, 2), "utf-8");
  return outPath;
}

// ── Copilot format ──────────────────────────────────────────────────────────

/**
 * Writes the Copilot MCP config to `<copilotHome>/mcp-config.json`.
 *
 * Same JSON schema as Claude (both use `mcpServers` wrapper).
 */
export function buildCopilotMcpConfig(transport: SensoriumTransport, copilotHomeDir: string): void {
  const servers: Record<string, Record<string, unknown>> = {};
  servers["sensorium-mcp"] = buildSensoriumJsonEntry(transport, { tools: ["*"] });

  for (const [name, cfg] of Object.entries(getMcpServers())) {
    servers[name] = formatJsonMcpEntry(cfg);
  }

  mkdirSync(copilotHomeDir, { recursive: true });
  writeFileSync(join(copilotHomeDir, "mcp-config.json"), JSON.stringify({ mcpServers: servers }, null, 2), "utf-8");
}

// ── Codex format ────────────────────────────────────────────────────────────

/** Escape a string for TOML double-quoted values. */
function tomlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Returns an array of `-c` CLI arguments for Codex (TOML-style config overrides).
 *
 * Codex supports stdio (`command`/`args`) and streamable HTTP (`url`).
 */
export function buildCodexMcpArgs(transport: SensoriumTransport): string[] {
  const args: string[] = [];

  args.push("-c", `mcp_servers.sensorium-mcp.url="http://127.0.0.1:${transport.httpPort}/mcp"`);
  if (transport.secret) args.push("-c", `mcp_servers.sensorium-mcp.bearer_token_env_var="SENSORIUM_MCP_SECRET"`);

  for (const [name, cfg] of Object.entries(getMcpServers())) {
    args.push(...formatCodexEntry(name, cfg));
  }

  return args;
}

function formatCodexEntry(name: string, cfg: McpServerConfig): string[] {
  const args: string[] = [];
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");

  if (cfg.type === "stdio") {
    args.push("-c", `mcp_servers.${safeName}.command="${tomlEscape(cfg.command)}"`);
    if (cfg.args?.length) {
      const argsStr = cfg.args.map(a => `"${tomlEscape(a)}"`).join(", ");
      args.push("-c", `mcp_servers.${safeName}.args=[${argsStr}]`);
    }
    if (cfg.env) {
      for (const [k, v] of Object.entries(cfg.env)) {
        args.push("-c", `mcp_servers.${safeName}.env.${k}="${tomlEscape(v)}"`);
      }
    }
  } else {
    args.push("-c", `mcp_servers.${safeName}.url="${tomlEscape(cfg.url)}"`);
    if (cfg.headers) {
      for (const [k, v] of Object.entries(cfg.headers)) {
        args.push("-c", `mcp_servers.${safeName}.http_headers.${k}="${tomlEscape(v)}"`);
      }
    }
  }

  return args;
}
