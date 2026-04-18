import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidAgentType, type AgentType } from "../config.js";

// ---------------------------------------------------------------------------
// Shared argument parsers
// ---------------------------------------------------------------------------

/** Parse an unknown value to a positive integer, or return undefined. */
export function parsePositiveInt(v: unknown): number | undefined {
  const parsed = typeof v === "number" ? v
    : typeof v === "string" ? Number(v)
    : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Validate an agentType string. Returns the value if valid, otherwise `fallback`
 * (defaults to `undefined`).
 */
export function parseAgentType(raw: unknown, fallback?: AgentType): AgentType | undefined {
  const s = typeof raw === "string" ? raw.trim() : "";
  return isValidAgentType(s) ? s : fallback;
}

export const COPILOT_HOME_DIR = "copilot-home";
const COPILOT_MCP_CONFIG_FILENAME = "mcp-config.json";
const COPILOT_INSTRUCTIONS_FILENAME = "copilot-instructions.md";
const COPILOT_SYSTEM_PROMPT =
  "You are a remote Copilot agent. " +
  "Start remote session with sensorium. Pass agentType='copilot' to start_session.";
export const DEFAULT_COPILOT_MODEL = "claude-opus-4-6";

export function writeMcpConfig(dest: string, port: number, secret: string | null): void {
  const serverConfig: Record<string, unknown> = {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
    tools: ["*"],
  };
  if (secret) serverConfig.headers = { Authorization: `Bearer ${secret}` };
  // Only include sensorium-mcp — additional local servers delay copilot startup
  // and can cause initialization timeouts when they fail to connect.
  const config = { mcpServers: { "sensorium-mcp": serverConfig } };
  writeFileSync(dest, JSON.stringify(config, null, 2), "utf-8");
}

export function writeCopilotHomeFiles(copilotHome: string, port: number, secret: string | null): void {
  mkdirSync(copilotHome, { recursive: true });
  writeMcpConfig(join(copilotHome, COPILOT_MCP_CONFIG_FILENAME), port, secret);
  writeFileSync(join(copilotHome, COPILOT_INSTRUCTIONS_FILENAME), COPILOT_SYSTEM_PROMPT, "utf-8");
}

/** Create a workspace directory with .copilotignore to prevent file scanning */
export function ensureCopilotWorkspace(baseDir: string): string {
  const wsDir = join(baseDir, "copilot-workspace");
  mkdirSync(wsDir, { recursive: true });
  const ignoreFile = join(wsDir, ".copilotignore");
  if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, "*\n", "utf-8");
  return wsDir;
}
