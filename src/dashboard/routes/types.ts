/**
 * Shared types and utilities for dashboard API route handlers.
 */

import type { Database } from "better-sqlite3";
import type { IncomingMessage } from "node:http";

// ─── Dashboard context (re-exported from routes.ts for external consumers) ──

export interface DashboardContext {
    getDb: () => Database;
    getActiveSessions: () => Array<{
        threadId: number;
        mcpSessionId: string;
        lastActivity: number;
        transportType: string;
        status: "active" | "disconnected";
        lastWaitCallAt: number | null;
    }>;
    serverStartTime: number;
}

// ─── Route handler types ────────────────────────────────────────────────────

export type JsonFn = (data: unknown, status?: number) => void;

export interface RouteArgs {
    req: IncomingMessage;
    url: URL;
    json: JsonFn;
    db: Database;
    ctx: DashboardContext;
}

export type RouteHandler = (args: RouteArgs) => boolean;

// ─── Shared utilities ───────────────────────────────────────────────────────

export function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

export function safeParseJSON(s: string): unknown {
    try { return JSON.parse(s); } catch { return s; }
}
