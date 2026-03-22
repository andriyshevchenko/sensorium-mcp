/**
 * Shared types used across modules in sensorium-mcp.
 *
 * This file defines the context interfaces that allow tool handlers
 * and transport layers to access shared state without coupling directly
 * to the monolithic index.ts.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// ─── Module-level config (read once at startup) ─────────────────────────────

export interface AppConfig {
  TELEGRAM_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  OPENAI_API_KEY: string;
  VOICE_ANALYSIS_URL: string;
  WAIT_TIMEOUT_MINUTES: number;
  DMN_ACTIVATION_HOURS: number;
  FILES_DIR: string;
  PKG_VERSION: string;
  AUTONOMOUS_MODE: boolean;
}

// ─── MCP server factory function type ───────────────────────────────────────

export type CreateMcpServerFn = (
  getMcpSessionId?: () => string | undefined,
  closeTransport?: () => void,
) => Server;
