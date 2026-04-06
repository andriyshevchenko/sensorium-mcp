import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const COPILOT_HOME_DIR = "copilot-home";
const COPILOT_MCP_CONFIG_FILENAME = "mcp-config.json";
const COPILOT_INSTRUCTIONS_FILENAME = "copilot-instructions.md";
const COPILOT_SYSTEM_PROMPT =
  "You are a remote Copilot agent. " +
  "Start remote session with sensorium. Pass agentType='copilot' to start_session.";
export const DEFAULT_COPILOT_MODEL = "claude-opus-4.6";

/**
 * Read MCP servers from Claude's settings.json (stdio + http servers).
 * Skips sensorium-mcp and sensorium-watcher since those are managed separately.
 */
function readClaudeMcpServers(): Record<string, unknown> {
  const skipKeys = new Set(["sensorium-mcp", "sensorium-watcher"]);
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (!existsSync(settingsPath)) return {};
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const servers = settings?.mcpServers ?? {};
    const result: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(servers)) {
      if (skipKeys.has(name)) continue;
      const cfg = config as Record<string, unknown>;
      if (cfg.disabled) continue;
      // Convert stdio servers to a format Copilot can use
      if (cfg.type === "stdio") {
        result[name] = { type: "stdio", command: cfg.command, args: cfg.args, env: cfg.env };
      } else if (cfg.type === "http") {
        result[name] = { type: "http", url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}) };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function writeMcpConfig(dest: string, port: number, secret: string | null): void {
  const serverConfig: Record<string, unknown> = {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
  };
  if (secret) serverConfig.headers = { Authorization: `Bearer ${secret}` };
  // Merge sensorium-mcp with shared MCP servers from Claude's config
  const sharedServers = readClaudeMcpServers();
  const config = { mcpServers: { "sensorium-mcp": serverConfig, ...sharedServers } };
  writeFileSync(dest, JSON.stringify(config, null, 2), "utf-8");
}

export function writeCopilotHomeFiles(copilotHome: string, port: number, secret: string | null): void {
  mkdirSync(copilotHome, { recursive: true });
  writeMcpConfig(join(copilotHome, COPILOT_MCP_CONFIG_FILENAME), port, secret);
  writeFileSync(join(copilotHome, COPILOT_INSTRUCTIONS_FILENAME), COPILOT_SYSTEM_PROMPT, "utf-8");
}
