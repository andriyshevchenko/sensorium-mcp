# Architecture

## Overview

sensorium-mcp is an MCP (Model Context Protocol) server that provides remote agent control via Telegram. AI agents connect over HTTP/SSE or stdio transport, receive operator instructions through Telegram forum topics, and execute work through subagents. Each session maps to a Telegram topic thread, enabling concurrent isolated sessions. The server handles bidirectional communication, persistent semantic memory, voice transcription and synthesis, scheduled tasks, and an autonomous drive system.

## Module Structure

### Core

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Main entry point — creates `Server` instances via `createMcpServer()` factory, wires per-session state, dispatches tool calls to handler modules, starts HTTP or stdio transport |
| `src/config.ts` | Reads and validates environment variables at startup, exports the `AppConfig` object, manages file storage directory, and checks the maintenance flag |
| `src/types.ts` | Shared TypeScript interfaces (`AppConfig`, `SessionState`, `ToolContext`, `DashboardCtx`, `CreateMcpServerFn`) used across modules |
| `src/tool-definitions.ts` | JSON schemas for all MCP tool definitions, returned by the `ListTools` handler |

### Transport

| File | Responsibility |
|------|---------------|
| `src/http-server.ts` | HTTP/SSE transport bootstrap — creates HTTP server, handles CORS, auth (`MCP_HTTP_SECRET`), session management, dashboard routing, session reaper, and graceful shutdown |
| `src/stdio-server.ts` | Stdio transport bootstrap — used when `MCP_HTTP_PORT` is not set; creates a single `StdioServerTransport` connection |

### Communication

| File | Responsibility |
|------|---------------|
| `src/telegram.ts` | Telegram Bot API client using native `fetch` — sends messages, manages forum topics, downloads files, handles media |
| `src/openai.ts` | OpenAI API client for Whisper transcription, TTS voice synthesis, GPT-4o-mini chat completions, embeddings, and video frame analysis |

### Tools

| File | Responsibility |
|------|---------------|
| `src/tools/start-session-tool.ts` | `start_session` — creates or resumes a Telegram forum topic, bootstraps memory, auto-schedules DMN reflection, returns session greeting with full reminders |
| `src/tools/wait-tool.ts` | `remote_copilot_wait_for_instructions` — core long-polling loop; polls dispatcher for operator messages every 2s, processes all media types, runs voice analysis, auto-saves episodes, injects relevant memory context, checks scheduled tasks, triggers auto-consolidation, sends SSE keepalives, detects maintenance flags |
| `src/tools/session-tools.ts` | `report_progress`, `hibernate` — sends progress updates to Telegram, handles hibernation with maintenance/drive/schedule checks |
| `src/tools/utility-tools.ts` | `send_file`, `send_voice`, `schedule_wake_up`, `get_version`, `get_usage_stats` — file/voice sending, scheduled task management, version info |
| `src/tools/memory-tools.ts` | All `memory_*` tools — save/search/update/forget semantic notes and procedures, consolidation, bootstrap, status, embedding backfill |

### State

| File | Responsibility |
|------|---------------|
| `src/memory.ts` | SQLite-backed persistent memory system (better-sqlite3) — semantic notes, episodes, procedures, topic index, embeddings, consolidation, and bootstrap assembly |
| `src/sessions.ts` | Session management — persists Telegram topic → thread ID mappings to disk, tracks active MCP transport sessions per thread, dead session timeout |
| `src/scheduler.ts` | Wake-up task scheduler — supports cron-based and delay-based tasks, persists state per-thread to disk, checked during wait polling |
| `src/dispatcher.ts` | Shared Telegram update dispatcher — file-system message broker that solves the single-poller problem; one instance polls `getUpdates`, writes to per-thread JSONL files, all instances read their own thread file |

### Utilities

| File | Responsibility |
|------|---------------|
| `src/utils.ts` | Shared helpers — `errorMessage()`, `errorResult()`, `describeADV()`, image extension list, constants |
| `src/logger.ts` | File + stderr logging with 5 MB rotation (`~/.remote-copilot-mcp/server.log`) |
| `src/intent.ts` | Lightweight synchronous intent classifier — classifies operator messages as `"conversational"` or `"task"` using exact-match and heuristics; defaults to `"task"` when uncertain |
| `src/response-builders.ts` | Builds reminder text appended to tool responses — `getReminders()` (full directive), `getShortReminder()` (minimal), plus keyword extraction and voice analysis tag formatting |
| `src/dashboard.ts` | Web UI SPA for monitoring agent sessions — serves HTML dashboard and authenticated JSON API endpoints (`/api/status`, `/api/sessions`, `/api/notes`, `/api/episodes`, etc.) |
| `src/markdown.ts` | Converts standard Markdown to Telegram MarkdownV2 format, working around `telegramify-markdown` limitations, with message splitting for length limits |
| `src/drive.ts` | Drive-based autonomy system — models dopaminergic motivation with escalating discomfort thresholds during operator silence; generates introspection prompts from memory |

## Tool Handler Pattern

Each tool handler is a **pure async function** in its own file under `src/tools/`. Handlers receive a typed context object containing:

- **Session state** accessors (getters/setters for `currentThreadId`, `waitCallCount`, `lastToolCallAt`, etc.)
- **Service clients** (`telegram`, `getMemoryDb`)
- **Config** (the `AppConfig` object)
- **Helper functions** (`resolveThreadId`, `getReminders`, `getShortReminder`, `errorResult`)

The main `index.ts` `createMcpServer()` factory:
1. Creates per-session mutable state variables in its closure
2. Registers a `CallToolRequest` handler that dispatches by tool name
3. Constructs the appropriate context object for each handler category
4. Calls the handler and returns its result

This pattern keeps handlers testable and decoupled from transport/server lifecycle concerns. No handler directly accesses global mutable state — all state flows through the context object.

## Reminder Hierarchy

Tool responses include contextual reminders so the agent always has essential information:

- **`getReminders()`** — Full directive with orchestrator role, thread ID, timestamp, and uptime. Used for `wait_for_instructions` and `start_session` responses where the agent needs complete context for decision-making. In autonomous mode, includes the orchestrator enforcement directive and subagent mandate. When the dispatcher drive is active, includes drive-specific instructions.

- **`getShortReminder()`** — Minimal thread ID + timestamp + uptime info. Used for all other tools (`report_progress`, `send_file`, `send_voice`, `memory_*`, etc.) to avoid bloating the conversation context.

- **Intent classifier** (`classifyIntent()`) determines how operator messages are treated:
  - `"conversational"` — acknowledgments and short replies (exact-match set + ≤3 word heuristic)
  - `"task"` — anything else, including when uncertain (safe default — includes full reminders)

## AUTONOMOUS_MODE

Controlled by the `AUTONOMOUS_MODE` environment variable (default: `false`).

- **When disabled** (`false`): Simple "follow the operator's instructions" directive. The agent acts as a direct executor.

- **When enabled** (`true`): The agent assumes an orchestrator role:
  - Full orchestrator directive enforced: "plan, decide, call tools — ALL other work MUST go through `runSubagent`"
  - DMN (Default Mode Network) reflection fires as a scheduled task during operator silence, generating introspective prompts from memory and the drive system
  - Subagent enforcement is non-negotiable — the orchestrator must never directly perform file reads, edits, searches, or code changes
  - The drive system (`drive.ts`) models escalating internal motivation based on idle time, encouraging autonomous exploration

## Update Protocol

The `scripts/update-watcher.ps1` PowerShell script manages zero-downtime updates:

1. **Registry polling** — Monitors the npm registry for new `sensorium-mcp` versions
   - **Production mode**: Daily check at a configured hour (`$POLL_AT_HOUR`, default: 4 AM)
   - **Development mode**: Polls every 60 seconds (`$POLL_INTERVAL_SECONDS`)

2. **Update detection** — When a new version is found:
   1. Writes a **maintenance flag** file (`~/.remote-copilot-mcp/maintenance.flag`) so agents can gracefully wind down
   2. Sends a **Telegram notification** to alert the operator
   3. Waits a **grace period** (`$GRACE_PERIOD_SECONDS`, default: 300s) for agents to notice and call sleep
   4. Enforces **minimum uptime** (`$MIN_UPTIME_SECONDS`, default: 600s) before allowing restart to batch rapid publishes

3. **Restart sequence**:
   1. Stops the running MCP server process
   2. Clears the npx cache to force a fresh download
   3. Restarts the MCP server
   4. Removes the maintenance flag file

4. **Agent-side handling** — During wait polling, the agent checks `checkMaintenanceFlag()`. When a flag is detected, the response instructs the agent to use Desktop Commander `Start-Sleep` to wait externally rather than calling MCP tools.

## Rules

1. **Tool handlers must be pure functions** — no global mutable state. All state flows through the typed context object constructed in `createMcpServer()`.

2. **Per-session state is isolated** in the `createMcpServer()` closure. Each HTTP session or stdio connection gets its own set of state variables (`waitCallCount`, `currentThreadId`, `lastToolCallAt`, etc.).

3. **All stderr logging goes through `logger.ts`** — writes to both `~/.remote-copilot-mcp/server.log` (with 5 MB rotation) and `process.stderr`.

4. **Default to `"task"` intent** when the classifier is uncertain. This is the safe path — it includes full reminders so the agent has all context needed to act.

5. **Never call MCP tools during maintenance** — when the maintenance flag is detected, the agent must use Desktop Commander `Start-Sleep` to wait externally until the update completes.

6. **Auto-consolidation is fire-and-forget** — never blocks the wait polling loop. Consolidation runs in the background and updates `lastConsolidationAt` on completion.
