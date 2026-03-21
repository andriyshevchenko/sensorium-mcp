/**
 * Shared types used across modules in sensorium-mcp.
 *
 * This file defines the context interfaces that allow tool handlers
 * and transport layers to access shared state without coupling directly
 * to the monolithic index.ts.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Database } from "better-sqlite3";
import type { TelegramClient } from "./telegram.js";

// ─── Module-level config (read once at startup) ─────────────────────────────

export interface AppConfig {
  TELEGRAM_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  OPENAI_API_KEY: string;
  VOICE_ANALYSIS_URL: string;
  WAIT_TIMEOUT_MINUTES: number;
  FILES_DIR: string;
  PKG_VERSION: string;
  AUTONOMOUS_MODE: boolean;
}

// ─── Per-session mutable state ──────────────────────────────────────────────

export interface SessionState {
  waitCallCount: number;
  sessionStartedAt: number;
  currentThreadId: number | undefined;
  lastToolCallAt: number;
  deadSessionAlerted: boolean;
  lastOperatorMessageAt: number;
  lastConsolidationAt: number;
  toolCallsSinceLastDelivery: number;
  previewedUpdateIds: Set<number>;
}

// ─── Tool handler context (passed to every tool handler) ────────────────────

export interface ToolContext {
  config: AppConfig;
  telegram: TelegramClient;
  getMemoryDb: () => Database;
  session: SessionState;

  /** Resolve threadId from args or fall back to session's currentThreadId. */
  resolveThreadId(args: Record<string, unknown> | undefined): number | undefined;

  /** Cap and add a message ID to the previewed set. */
  addPreviewedId(id: number): void;

  /** Append time/thread/workflow hints to a tool response string. */
  getReminders(threadId?: number, driveActive?: boolean): string;

  /** Convert standard markdown to Telegram MarkdownV2. */
  convertMarkdown(markdown: string): string;

  /** Get the MCP session ID for this connection. */
  getMcpSessionId?: () => string | undefined;
}

// ─── Dashboard context (used by the HTTP dashboard) ─────────────────────────

export interface DashboardCtx {
  getDb: () => Database;
  getActiveSessions: () => Array<{
    mcpSessionId: string;
    threadId: number;
    startedAt: string;
    lastToolCallAt: string;
    toolName?: string;
  }>;
  serverStartTime: number;
}

// ─── MCP server factory function type ───────────────────────────────────────

export type CreateMcpServerFn = (
  getMcpSessionId?: () => string | undefined,
  closeTransport?: () => void,
) => Server;
