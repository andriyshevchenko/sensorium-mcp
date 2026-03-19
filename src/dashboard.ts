/**
 * Dashboard — Beautiful web UI for monitoring sensorium-mcp agent sessions.
 *
 * Architecture:
 *   GET /                → Serve the SPA (single-page HTML with embedded CSS/JS)
 *   GET /api/status      → Memory stats + session overview
 *   GET /api/sessions    → Active MCP sessions
 *   GET /api/notes       → Browse semantic notes (query params: type, limit, sort)
 *   GET /api/episodes    → Recent episodes (query params: threadId, limit)
 *   GET /api/topics      → Topic index
 *   GET /api/search      → Search notes (query param: q)
 *
 * All /api/* routes require Bearer token auth (same as MCP_HTTP_SECRET).
 * The dashboard page itself is served without auth — API token entered in the UI.
 */

import type { Database } from "better-sqlite3";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
    getRecentEpisodes,
    getTopicIndex,
    getTopSemanticNotes,
    searchSemanticNotesRanked,
    type SemanticNote
} from "./memory.js";
import { rateLimiter } from "./rate-limiter.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DashboardContext {
    getDb: () => Database;
    getActiveSessions: () => Array<{
        threadId: number;
        mcpSessionId: string;
        lastActivity: number;
        transportType: string;
    }>;
    serverStartTime: number;
}

// ─── Route handler ───────────────────────────────────────────────────────────

/**
 * Handle a dashboard or API request. Returns true if handled, false if not a dashboard route.
 */
export function handleDashboardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: DashboardContext,
    authToken?: string
): boolean {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Serve dashboard SPA
    if (path === "/" || path === "/dashboard") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getDashboardHTML());
        return true;
    }

    // All /api/* routes require auth
    if (path.startsWith("/api/")) {
        if (authToken) {
            const auth = req.headers.authorization;
            const providedToken = auth?.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token");
            if (!providedToken || providedToken !== authToken) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Unauthorized" }));
                return true;
            }
        }
        return handleApiRoute(path, url, res, ctx);
    }

    return false;
}

function handleApiRoute(
    path: string,
    url: URL,
    res: ServerResponse,
    ctx: DashboardContext
): boolean {
    const json = (data: unknown, status = 200) => {
        res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify(data));
    };

    try {
        const db = ctx.getDb();

        if (path === "/api/status") {
            const totalEpisodes = (db.prepare(`SELECT COUNT(*) as cnt FROM episodes`).get() as { cnt: number }).cnt;
            const unconsolidatedEpisodes = (db.prepare(`SELECT COUNT(*) as cnt FROM episodes WHERE consolidated = 0`).get() as { cnt: number }).cnt;
            const totalSemanticNotes = (db.prepare(`SELECT COUNT(*) as cnt FROM semantic_notes WHERE valid_to IS NULL AND superseded_by IS NULL`).get() as { cnt: number }).cnt;
            const totalProcedures = (db.prepare(`SELECT COUNT(*) as cnt FROM procedures`).get() as { cnt: number }).cnt;
            const totalVoiceSignatures = (db.prepare(`SELECT COUNT(*) as cnt FROM voice_signatures`).get() as { cnt: number }).cnt;
            const lastConso = db.prepare(`SELECT run_at FROM meta_consolidation_log ORDER BY run_at DESC LIMIT 1`).get() as { run_at: string } | undefined;
            const topTopics = getTopicIndex(db).slice(0, 10);
            const dbSizeRow = db.prepare(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`).get() as { size: number } | undefined;
            const sessions = ctx.getActiveSessions();
            json({
                memory: { totalEpisodes, unconsolidatedEpisodes, totalSemanticNotes, totalProcedures, totalVoiceSignatures, lastConsolidation: lastConso?.run_at ?? null, topTopics, dbSizeBytes: dbSizeRow?.size ?? 0 },
                activeSessions: sessions.length,
                sessions,
                uptime: Math.floor((Date.now() - ctx.serverStartTime) / 1000),
                serverTime: new Date().toISOString(),
            });
            return true;
        }

        if (path === "/api/sessions") {
            json(ctx.getActiveSessions());
            return true;
        }

        if (path === "/api/notes") {
            const type = url.searchParams.get("type") || undefined;
            const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
            const sort = (url.searchParams.get("sort") ?? "created_at") as "created_at" | "confidence" | "access_count";
            const validTypes = ["fact", "preference", "pattern", "entity", "relationship"];
            const notes = getTopSemanticNotes(db, {
                type: type && validTypes.includes(type) ? type as SemanticNote["type"] : undefined,
                limit: Math.min(limit, 200),
                sortBy: sort,
            });
            json(notes);
            return true;
        }

        if (path === "/api/episodes") {
            const threadId = url.searchParams.get("threadId") ? parseInt(url.searchParams.get("threadId")!, 10) : undefined;
            const limit = parseInt(url.searchParams.get("limit") ?? "30", 10);
            const cappedLimit = Math.min(limit, 200);
            if (threadId) {
                json(getRecentEpisodes(db, threadId, cappedLimit));
            } else {
                const rows = db.prepare(`SELECT * FROM episodes ORDER BY timestamp DESC LIMIT ?`).all(cappedLimit) as Record<string, unknown>[];
                json(rows.map((r) => ({
                    episodeId: r.episode_id, threadId: r.thread_id, type: r.type, modality: r.modality,
                    content: typeof r.content === "string" ? safeParseJSON(r.content) : r.content,
                    importance: r.importance, consolidated: !!r.consolidated, createdAt: r.timestamp,
                })));
            }
            return true;
        }

        if (path === "/api/topics") {
            json(getTopicIndex(db));
            return true;
        }

        if (path === "/api/search") {
            const q = url.searchParams.get("q")?.trim();
            if (!q) { json({ error: "Missing ?q= parameter" }, 400); return true; }
            json(searchSemanticNotesRanked(db, q, { maxResults: parseInt(url.searchParams.get("limit") ?? "20", 10) }));
            return true;
        }

        if (path === "/api/rate-limits") {
            json(rateLimiter.getStats());
            return true;
        }

        json({ error: "Not found" }, 404);
        return true;
    } catch (err) {
        json({ error: err instanceof Error ? err.message : String(err) }, 500);
        return true;
    }
}

function safeParseJSON(s: string): unknown {
    try { return JSON.parse(s); } catch { return s; }
}

// ─── Dashboard SPA HTML ──────────────────────────────────────────────────────

function getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sensorium MCP — Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            surface: '#0f1419',
            card: '#1a1f2e',
            cardHover: '#222839',
            accent: '#6366f1',
            accentLight: '#818cf8',
            success: '#22c55e',
            warn: '#f59e0b',
            danger: '#ef4444',
            muted: '#6b7280',
            textPrimary: '#e5e7eb',
            textSecondary: '#9ca3af',
          },
          fontFamily: {
            sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
            mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
          },
          animation: {
            'fade-in': 'fadeIn 0.3s ease-out',
            'slide-up': 'slideUp 0.4s ease-out',
            'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
          },
          keyframes: {
            fadeIn: { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
            slideUp: { '0%': { opacity: 0, transform: 'translateY(12px)' }, '100%': { opacity: 1, transform: 'translateY(0)' } },
          },
        },
      },
    };
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    body { background: #0f1419; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: #1a1f2e; }
    ::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #4b5563; }
    .glass { background: rgba(26, 31, 46, 0.8); backdrop-filter: blur(12px); border: 1px solid rgba(99, 102, 241, 0.1); }
    .stat-glow { box-shadow: 0 0 20px rgba(99, 102, 241, 0.08); }
    .priority-2 { border-left: 3px solid #ef4444; }
    .priority-1 { border-left: 3px solid #f59e0b; }
    .priority-0 { border-left: 3px solid transparent; }
    .type-badge { font-size: 0.65rem; padding: 2px 6px; border-radius: 9999px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .type-fact { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
    .type-preference { background: rgba(168, 85, 247, 0.15); color: #c084fc; }
    .type-pattern { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
    .type-entity { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    .type-relationship { background: rgba(244, 114, 182, 0.15); color: #f472b6; }
    .tab-active { border-bottom: 2px solid #6366f1; color: #e5e7eb; }
    .tab-inactive { border-bottom: 2px solid transparent; color: #6b7280; }
    .tab-inactive:hover { color: #9ca3af; }
  </style>
</head>
<body class="font-sans text-textPrimary min-h-screen">
  <!-- Auth overlay -->
  <div id="auth-overlay" class="fixed inset-0 z-50 flex items-center justify-center bg-surface/95 backdrop-blur-sm">
    <div class="glass rounded-2xl p-8 max-w-md w-full mx-4 animate-slide-up">
      <div class="flex items-center gap-3 mb-6">
        <div class="w-10 h-10 rounded-xl bg-accent/20 flex items-center justify-center">
          <svg class="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
          </svg>
        </div>
        <div>
          <h2 class="text-lg font-semibold">Sensorium MCP</h2>
          <p class="text-sm text-textSecondary">Enter your API token</p>
        </div>
      </div>
      <input id="token-input" type="password" placeholder="MCP_HTTP_SECRET"
        class="w-full px-4 py-3 rounded-xl bg-surface border border-gray-700 text-textPrimary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition font-mono text-sm" />
      <button onclick="authenticate()" class="w-full mt-4 px-4 py-3 rounded-xl bg-accent hover:bg-accentLight text-white font-medium transition">
        Connect
      </button>
      <p id="auth-error" class="mt-3 text-sm text-danger hidden">Invalid token</p>
    </div>
  </div>

  <!-- Main dashboard -->
  <div id="dashboard" class="hidden">
    <!-- Header -->
    <header class="glass sticky top-0 z-40 border-b border-gray-800/50">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-purple-500 flex items-center justify-center">
            <span class="text-white text-sm font-bold">S</span>
          </div>
          <div>
            <h1 class="text-lg font-semibold tracking-tight">Sensorium MCP</h1>
            <p class="text-xs text-textSecondary">Agent Dashboard</p>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <div id="connection-status" class="flex items-center gap-2 text-sm">
            <span class="w-2 h-2 rounded-full bg-success animate-pulse-slow"></span>
            <span class="text-textSecondary">Connected</span>
          </div>
          <div id="uptime-display" class="text-sm text-textSecondary font-mono"></div>
          <button onclick="logout()" class="text-sm text-muted hover:text-textSecondary transition">Disconnect</button>
        </div>
      </div>
    </header>

    <!-- Stats bar -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6 py-6">
      <div id="stats-grid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <!-- Filled by JS -->
      </div>
    </div>

    <!-- Tabs -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6">
      <nav class="flex gap-6 border-b border-gray-800/50 mb-6">
        <button onclick="switchTab('sessions')" id="tab-sessions" class="pb-3 text-sm font-medium tab-active transition">Sessions</button>
        <button onclick="switchTab('notes')" id="tab-notes" class="pb-3 text-sm font-medium tab-inactive transition">Memory Notes</button>
        <button onclick="switchTab('episodes')" id="tab-episodes" class="pb-3 text-sm font-medium tab-inactive transition">Episodes</button>
        <button onclick="switchTab('topics')" id="tab-topics" class="pb-3 text-sm font-medium tab-inactive transition">Topics</button>
        <button onclick="switchTab('ratelimits')" id="tab-ratelimits" class="pb-3 text-sm font-medium tab-inactive transition">Rate Limits</button>
      </nav>
    </div>

    <!-- Tab content -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6 pb-12">
      <!-- Sessions -->
      <div id="panel-sessions" class="animate-fade-in">
        <div id="sessions-list" class="space-y-3"></div>
        <p id="sessions-empty" class="hidden text-center text-textSecondary py-12">No active sessions</p>
      </div>

      <!-- Notes -->
      <div id="panel-notes" class="hidden animate-fade-in">
        <div class="flex flex-wrap items-center gap-3 mb-4">
          <input id="notes-search" type="text" placeholder="Search notes..."
            class="flex-1 min-w-[200px] px-4 py-2 rounded-xl bg-card border border-gray-700 text-sm text-textPrimary placeholder-muted focus:outline-none focus:border-accent transition" />
          <select id="notes-type" onchange="loadNotes()"
            class="px-3 py-2 rounded-xl bg-card border border-gray-700 text-sm text-textPrimary focus:outline-none">
            <option value="">All types</option>
            <option value="fact">Facts</option>
            <option value="preference">Preferences</option>
            <option value="pattern">Patterns</option>
            <option value="entity">Entities</option>
            <option value="relationship">Relationships</option>
          </select>
          <select id="notes-sort" onchange="loadNotes()"
            class="px-3 py-2 rounded-xl bg-card border border-gray-700 text-sm text-textPrimary focus:outline-none">
            <option value="created_at">Newest</option>
            <option value="confidence">Confidence</option>
            <option value="access_count">Most accessed</option>
          </select>
        </div>
        <div id="notes-list" class="space-y-2"></div>
      </div>

      <!-- Episodes -->
      <div id="panel-episodes" class="hidden animate-fade-in">
        <div class="flex items-center gap-3 mb-4">
          <input id="episodes-thread" type="number" placeholder="Thread ID (optional)"
            class="w-48 px-4 py-2 rounded-xl bg-card border border-gray-700 text-sm text-textPrimary placeholder-muted focus:outline-none focus:border-accent transition" />
          <button onclick="loadEpisodes()" class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight text-white text-sm font-medium transition">Load</button>
        </div>
        <div id="episodes-list" class="space-y-2"></div>
      </div>

      <!-- Topics -->
      <div id="panel-topics" class="hidden animate-fade-in">
        <div id="topics-grid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"></div>
      </div>

      <!-- Rate Limits -->
      <div id="panel-ratelimits" class="hidden animate-fade-in">
        <div id="ratelimits-summary" class="mb-4 glass rounded-xl p-4"></div>
        <div id="ratelimits-grid" class="grid grid-cols-1 sm:grid-cols-2 gap-3"></div>
      </div>
    </div>
  </div>

  <script>
    // ─── State ─────────────────────────────────────────────────────────
    let token = localStorage.getItem('sensorium_token') || '';
    let currentTab = 'sessions';
    let refreshTimer = null;

    // ─── Auth ──────────────────────────────────────────────────────────
    async function authenticate() {
      const input = document.getElementById('token-input');
      token = input.value.trim();
      if (!token) { token = 'no-auth'; } // allow no-auth mode
      try {
        const res = await api('/api/status');
        if (res) {
          localStorage.setItem('sensorium_token', token);
          document.getElementById('auth-overlay').classList.add('hidden');
          document.getElementById('dashboard').classList.remove('hidden');
          startRefresh();
        }
      } catch (e) {
        document.getElementById('auth-error').classList.remove('hidden');
      }
    }

    function logout() {
      localStorage.removeItem('sensorium_token');
      token = '';
      if (refreshTimer) clearInterval(refreshTimer);
      document.getElementById('dashboard').classList.add('hidden');
      document.getElementById('auth-overlay').classList.remove('hidden');
    }

    // Auto-connect if token saved
    if (token) {
      api('/api/status').then(data => {
        if (data) {
          document.getElementById('auth-overlay').classList.add('hidden');
          document.getElementById('dashboard').classList.remove('hidden');
          startRefresh();
        }
      }).catch(() => {
        localStorage.removeItem('sensorium_token');
        token = '';
      });
    }

    // Enter key on token input
    document.getElementById('token-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') authenticate();
    });

    // ─── API ───────────────────────────────────────────────────────────
    async function api(path) {
      const res = await fetch(path, {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    }

    // ─── Rendering ─────────────────────────────────────────────────────
    function formatUptime(seconds) {
      const d = Math.floor(seconds / 86400);
      const h = Math.floor((seconds % 86400) / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      if (d > 0) return d + 'd ' + h + 'h';
      if (h > 0) return h + 'h ' + m + 'm';
      return m + 'm';
    }

    function timeAgo(iso) {
      if (!iso) return 'never';
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.floor(hours / 24) + 'd ago';
    }

    function statCard(label, value, icon, color = 'accent') {
      return '<div class="glass rounded-xl p-4 stat-glow animate-slide-up">' +
        '<div class="flex items-center gap-2 mb-2">' +
          '<span class="text-' + color + '">' + icon + '</span>' +
          '<span class="text-xs text-textSecondary font-medium uppercase tracking-wider">' + label + '</span>' +
        '</div>' +
        '<div class="text-2xl font-bold font-mono">' + value + '</div>' +
      '</div>';
    }

    function renderStats(data) {
      const m = data.memory;
      const grid = document.getElementById('stats-grid');
      grid.innerHTML =
        statCard('Sessions', data.activeSessions,
          '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
          'success') +
        statCard('Notes', m.totalSemanticNotes,
          '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
          'accentLight') +
        statCard('Episodes', m.totalEpisodes,
          '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>',
          'warn') +
        statCard('Unconsolidated', m.unconsolidatedEpisodes,
          '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
          m.unconsolidatedEpisodes > 10 ? 'danger' : 'success') +
        statCard('Procedures', m.totalProcedures,
          '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>') +
        statCard('Uptime', formatUptime(data.uptime),
          '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M12 5l7 7-7 7"/></svg>',
          'success');

      document.getElementById('uptime-display').textContent = formatUptime(data.uptime);
    }

    function renderSessions(sessions) {
      const list = document.getElementById('sessions-list');
      const empty = document.getElementById('sessions-empty');
      if (!sessions.length) {
        list.innerHTML = '';
        empty.classList.remove('hidden');
        return;
      }
      empty.classList.add('hidden');
      list.innerHTML = sessions.map(s => {
        const idle = Math.floor((Date.now() - s.lastActivity) / 60000);
        const statusColor = idle < 5 ? 'success' : idle < 30 ? 'warn' : 'danger';
        const statusLabel = idle < 5 ? 'Active' : idle < 30 ? 'Idle ' + idle + 'm' : 'Dormant ' + idle + 'm';
        return '<div class="glass rounded-xl p-4 animate-slide-up">' +
          '<div class="flex items-center justify-between">' +
            '<div class="flex items-center gap-3">' +
              '<span class="w-2.5 h-2.5 rounded-full bg-' + statusColor + '"></span>' +
              '<div>' +
                '<div class="font-medium">Thread ' + s.threadId + '</div>' +
                '<div class="text-xs text-textSecondary font-mono">' + s.mcpSessionId.slice(0, 12) + '...</div>' +
              '</div>' +
            '</div>' +
            '<div class="text-right">' +
              '<div class="text-sm font-medium text-' + statusColor + '">' + statusLabel + '</div>' +
              '<div class="text-xs text-textSecondary">' + s.transportType + '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderNotes(notes) {
      const list = document.getElementById('notes-list');
      list.innerHTML = notes.map(n => {
        const pClass = 'priority-' + (n.priority || 0);
        return '<div class="glass rounded-xl p-4 ' + pClass + ' animate-fade-in">' +
          '<div class="flex items-start justify-between gap-3">' +
            '<div class="flex-1 min-w-0">' +
              '<div class="flex items-center gap-2 mb-1">' +
                '<span class="type-badge type-' + n.type + '">' + n.type + '</span>' +
                (n.priority >= 2 ? '<span class="type-badge" style="background:rgba(239,68,68,0.15);color:#f87171">HIGH IMPORTANCE</span>' : '') +
                (n.priority === 1 ? '<span class="type-badge" style="background:rgba(245,158,11,0.15);color:#fbbf24">NOTABLE</span>' : '') +
                '<span class="text-xs text-textSecondary">' + n.noteId + '</span>' +
              '</div>' +
              '<p class="text-sm text-textPrimary leading-relaxed">' + escapeHtml(n.content) + '</p>' +
              '<div class="flex flex-wrap gap-1.5 mt-2">' +
                (n.keywords || []).map(k => '<span class="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accentLight">' + escapeHtml(k) + '</span>').join('') +
              '</div>' +
            '</div>' +
            '<div class="text-right shrink-0">' +
              '<div class="text-sm font-mono text-textSecondary">' + (n.confidence * 100).toFixed(0) + '%</div>' +
              '<div class="text-xs text-muted">' + timeAgo(n.createdAt) + '</div>' +
              '<div class="text-xs text-muted">' + n.accessCount + ' hits</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderEpisodes(episodes) {
      const list = document.getElementById('episodes-list');
      const modalityIcons = {
        text: '💬', voice: '🎤', image: '🖼️', file: '📎', system: '⚙️'
      };
      list.innerHTML = episodes.map(ep => {
        const icon = modalityIcons[ep.modality] || '📝';
        const content = ep.content ? (typeof ep.content === 'object' ? JSON.stringify(ep.content).slice(0, 300) : String(ep.content).slice(0, 300)) : '(no content)';
        return '<div class="glass rounded-xl p-4 animate-fade-in">' +
          '<div class="flex items-start gap-3">' +
            '<span class="text-lg">' + icon + '</span>' +
            '<div class="flex-1 min-w-0">' +
              '<div class="flex items-center gap-2 mb-1">' +
                '<span class="type-badge type-fact">' + ep.type + '</span>' +
                '<span class="text-xs text-textSecondary font-mono">' + ep.episodeId + '</span>' +
                '<span class="text-xs text-muted">' + timeAgo(ep.createdAt) + '</span>' +
              '</div>' +
              '<p class="text-sm text-textSecondary leading-relaxed break-words">' + escapeHtml(content) + '</p>' +
            '</div>' +
            '<div class="text-xs text-muted shrink-0">imp: ' + ((ep.importance || 0) * 100).toFixed(0) + '%</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderTopics(topics) {
      const grid = document.getElementById('topics-grid');
      if (!topics.length) { grid.innerHTML = '<p class="text-textSecondary col-span-full text-center py-12">No topics yet</p>'; return; }
      const maxCount = Math.max(...topics.map(t => t.count));
      grid.innerHTML = topics.map(t => {
        const intensity = Math.max(0.15, t.count / maxCount);
        return '<div class="glass rounded-xl p-4 animate-slide-up" style="border-left: 3px solid rgba(99,102,241,' + intensity + ')">' +
          '<div class="font-medium text-sm">' + escapeHtml(t.topic) + '</div>' +
          '<div class="flex items-center justify-between mt-2">' +
            '<span class="text-lg font-bold font-mono text-accent">' + t.count + '</span>' +
            '<span class="text-xs text-muted">' + timeAgo(t.lastSeen) + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderRateLimits(data) {
      const summary = document.getElementById('ratelimits-summary');
      const grid = document.getElementById('ratelimits-grid');
      summary.innerHTML =
        '<div class="flex items-center justify-between">' +
          '<div>' +
            '<div class="text-sm text-textSecondary">Active Agents Sharing Resources</div>' +
            '<div class="text-3xl font-bold font-mono text-accent">' + data.activeSessions + '</div>' +
          '</div>' +
          '<div class="text-right">' +
            '<div class="text-sm text-textSecondary">Total Calls (Last Hour)</div>' +
            '<div class="text-3xl font-bold font-mono">' + data.totalCallsLastHour + '</div>' +
          '</div>' +
        '</div>';
      if (!data.services || !data.services.length) {
        grid.innerHTML = '<p class="text-textSecondary col-span-full text-center py-8">No services tracked yet</p>';
        return;
      }
      grid.innerHTML = data.services.map(function(svc) {
        var pct = svc.usagePercent;
        var barColor = pct > 80 ? 'danger' : pct > 50 ? 'warn' : 'success';
        var breakdown = '';
        if (svc.sessionBreakdown && svc.sessionBreakdown.length > 0) {
          breakdown = '<div class="mt-3 space-y-1">' +
            '<div class="text-xs text-textSecondary font-medium uppercase tracking-wider">Per-Session Breakdown</div>' +
            svc.sessionBreakdown.map(function(s) {
              return '<div class="flex items-center justify-between text-xs">' +
                '<span class="text-textSecondary font-mono">Thread ' + (s.threadId || '?') + '</span>' +
                '<span class="font-mono text-textPrimary">' + s.calls + ' calls</span>' +
              '</div>';
            }).join('') +
          '</div>';
        }
        return '<div class="glass rounded-xl p-4 animate-slide-up">' +
          '<div class="flex items-center justify-between mb-3">' +
            '<div>' +
              '<div class="font-medium text-sm">' + escapeHtml(svc.description) + '</div>' +
              '<div class=\"text-xs text-muted font-mono\">' + escapeHtml(svc.service) + '</div>' +
            '</div>' +
            '<div class="text-right">' +
              '<div class="text-lg font-bold font-mono text-' + barColor + '">' + pct + '%</div>' +
            '</div>' +
          '</div>' +
          '<div class="w-full h-2 bg-surface rounded-full overflow-hidden mb-3">' +
            '<div class="h-full bg-' + barColor + ' rounded-full transition-all" style="width:' + Math.min(pct, 100) + '%"></div>' +
          '</div>' +
          '<div class="grid grid-cols-2 gap-2 text-xs">' +
            '<div><span class="text-textSecondary">Window:</span> <span class="font-mono">' + svc.callsInWindow + '/' + svc.maxPerWindow + '</span></div>' +
            '<div><span class="text-textSecondary">Burst:</span> <span class="font-mono">' + svc.availableTokens + '/' + svc.burstCapacity + '</span></div>' +
          '</div>' +
          breakdown +
        '</div>';
      }).join('');
    }

    // ─── Tab switching ──────────────────────────────────────────────────
    function switchTab(tab) {
      const tabs = ['sessions', 'notes', 'episodes', 'topics', 'ratelimits'];
      tabs.forEach(t => {
        document.getElementById('panel-' + t).classList.toggle('hidden', t !== tab);
        document.getElementById('tab-' + t).className = 'pb-3 text-sm font-medium transition ' + (t === tab ? 'tab-active' : 'tab-inactive');
      });
      currentTab = tab;
      refreshCurrentTab();
    }

    // ─── Data loading ─────────────────────────────────────────────────
    let searchDebounce = null;
    document.getElementById('notes-search')?.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => loadNotes(), 300);
    });

    async function loadNotes() {
      try {
        const q = document.getElementById('notes-search').value.trim();
        const type = document.getElementById('notes-type').value;
        const sort = document.getElementById('notes-sort').value;
        let notes;
        if (q) {
          notes = await api('/api/search?q=' + encodeURIComponent(q) + '&limit=50');
        } else {
          notes = await api('/api/notes?limit=50' + (type ? '&type=' + type : '') + '&sort=' + sort);
        }
        renderNotes(notes);
      } catch (e) { console.error('Notes load error:', e); }
    }

    async function loadEpisodes() {
      try {
        const threadId = document.getElementById('episodes-thread').value;
        let url = '/api/episodes?limit=30';
        if (threadId) url += '&threadId=' + threadId;
        const episodes = await api(url);
        renderEpisodes(episodes);
      } catch (e) { console.error('Episodes load error:', e); }
    }

    async function loadTopics() {
      try {
        const topics = await api('/api/topics');
        renderTopics(topics);
      } catch (e) { console.error('Topics load error:', e); }
    }

    async function loadRateLimits() {
      try {
        const data = await api('/api/rate-limits');
        renderRateLimits(data);
      } catch (e) { console.error('Rate limits load error:', e); }
    }

    async function refreshCurrentTab() {
      const data = await api('/api/status').catch(() => null);
      if (data) {
        renderStats(data);
        renderSessions(data.sessions);
      }
      if (currentTab === 'notes') loadNotes();
      if (currentTab === 'episodes') loadEpisodes();
      if (currentTab === 'topics') loadTopics();
      if (currentTab === 'ratelimits') loadRateLimits();
    }

    function startRefresh() {
      refreshCurrentTab();
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(refreshCurrentTab, 5000);
    }

    // ─── Utilities ──────────────────────────────────────────────────────
    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
}
