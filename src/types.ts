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

// ─── Shared tool-result types ───────────────────────────────────────────────

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; data: string; mimeType: string };

/**
 * A single block inside a `ToolResult.content` array.
 *
 * Most tools only produce `TextBlock`s, but media-processing tools
 * (voice, photo, video note) may also emit `ImageBlock`s.
 */
export type ContentBlock = TextBlock | ImageBlock;

/**
 * Standard return shape for every MCP tool handler.
 */
export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}
