import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const COPILOT_HOME_DIR = "copilot-home";
export const COPILOT_MCP_CONFIG_FILENAME = "mcp-config.json";
export const COPILOT_INSTRUCTIONS_FILENAME = "copilot-instructions.md";
export const COPILOT_SYSTEM_PROMPT =
  "You are a remote Copilot agent. " +
  "Start remote session with sensorium. Pass agentType='copilot' to start_session.";
export const DEFAULT_COPILOT_MODEL = "claude-opus-4.6";

export function writeMcpConfig(dest: string, port: number, secret: string | null): void {
  const serverConfig: Record<string, unknown> = {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
  };
  if (secret) serverConfig.headers = { Authorization: `Bearer ${secret}` };
  const config = { mcpServers: { "sensorium-mcp": serverConfig } };
  writeFileSync(dest, JSON.stringify(config, null, 2), "utf-8");
}

export function writeCopilotHomeFiles(copilotHome: string, port: number, secret: string | null): void {
  mkdirSync(copilotHome, { recursive: true });
  writeMcpConfig(join(copilotHome, COPILOT_MCP_CONFIG_FILENAME), port, secret);
  writeFileSync(join(copilotHome, COPILOT_INSTRUCTIONS_FILENAME), COPILOT_SYSTEM_PROMPT, "utf-8");
}
