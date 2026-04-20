/**
 * Shared types and utilities for dashboard API route handlers.
 */

import type { Database } from "better-sqlite3";
import type { IncomingMessage } from "node:http";

// ─── Dashboard context (re-exported from routes.ts for external consumers) ──

export interface DashboardContext {
    getDb: () => Database;
    getActiveSessions: () => Array<{
        threadId: number | null;
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

export type RouteHandler = (args: RouteArgs) => boolean | Promise<boolean>;

// ─── Shared utilities ───────────────────────────────────────────────────────

const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MB

export function readBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
                req.destroy();
                reject(new Error(`Request body exceeds ${maxBytes} bytes`));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

export function safeParseJSON(s: string): unknown {
    try { return JSON.parse(s); } catch { return s; }
}
