# Architecture

## Overview

sensorium-mcp is an MCP (Model Context Protocol) server that provides remote agent control via Telegram. AI agents connect over HTTP/SSE or stdio transport, receive operator instructions through Telegram forum topics, and execute work through subagents. Each session maps to a Telegram topic thread, enabling concurrent isolated sessions. The server handles bidirectional communication, persistent semantic memory, voice transcription and synthesis, scheduled tasks, and an autonomous drive system.

## Module Structure

After the modular decomposition refactoring, the codebase is organized into a layered directory tree. Each directory corresponds to a dependency layer (Layer 0–5). Imports flow strictly downward: a module may only import from its own layer or lower layers.

```
src/
├── index.ts                 [  46] Entrypoint: startup + transport mode selection
├── config.ts                [  50] Env parsing, validation, AppConfig export
├── types.ts                 [  25] Shared interfaces (AppConfig, SessionState, ToolContext, etc.)
├── utils.ts                 [  67] errorMessage, errorResult, describeADV, constants
├── logger.ts                [  79] File + stderr logging with 5 MB rotation
├── intent.ts                [  31] Synchronous intent classifier (conversational vs task)
├── markdown.ts              [ 110] MD → Telegram MarkdownV2 conversion + message splitting
├── response-builders.ts     [ 160] Reminder text builders + keyword extraction
├── drive.ts                 [  76] 3-phase probabilistic autonomy model
├── scheduler.ts             [ 259] Wake-up task scheduler (cron + delay), disk-persisted
├── sessions.ts              [  87] Name→thread mapping + MCP session registry
├── http-server.ts           [ 277] HTTP/SSE transport, CORS, auth, session reaper
├── stdio-server.ts          [  27] Stdio transport bootstrap
├── telegram.ts              [ 399] Telegram Bot API client (send, topics, media, files)
│
├── memory.ts                [   8] ← barrel re-export of data/memory/*
├── openai.ts                [  18] ← barrel re-export of integrations/openai/*
├── dispatcher.ts            [   8] ← barrel re-export of services/dispatcher/*
├── dashboard.ts             [   9] ← barrel re-export of dashboard/*
├── tool-definitions.ts      [   1] ← barrel re-export of tools/definitions
│
├── data/                           # Layer 2: Data access + persistence
│   ├── file-storage.ts      [  52] Binary file save/cleanup (extracted from config.ts)
│   ├── templates.ts         [  48] Template file loading, rendering, caching
│   └── memory/                     # SQLite-backed persistent memory (better-sqlite3)
│       ├── index.ts          [  13] Barrel re-export
│       ├── schema.ts        [ 313] DB init, migrations, table definitions
│       ├── episodes.ts      [ 127] Episode CRUD + batch save
│       ├── semantic.ts      [ 457] Semantic note CRUD + ranked search + embeddings
│       ├── procedures.ts    [ 168] Procedure CRUD + matching
│       ├── voice-sig.ts     [  95] Voice signature storage + baseline
│       ├── consolidation.ts [ 285] Intelligent consolidation engine
│       └── bootstrap.ts     [ 272] Session memory briefing assembly + status
│
├── integrations/                   # Layer 1: External service clients
│   ├── openai/
│   │   ├── index.ts          [   5] Barrel re-export
│   │   ├── chat.ts          [  92] Chat completions + embeddings + cosine similarity
│   │   ├── speech.ts        [  90] TTS synthesis + Whisper transcription
│   │   ├── vision.ts        [ 129] Image analysis (GPT-4o vision)
│   │   ├── video.ts         [ 125] Video frame extraction (ffmpeg)
│   │   └── voice-emotion.ts [  82] Voice emotion analysis service client
│   └── telegram/
│       └── types.ts         [ 110] Telegram API type definitions
│
├── services/                       # Layer 3: Business logic + orchestration
│   └── dispatcher/
│       ├── index.ts          [   8] Barrel re-export
│       ├── broker.ts        [ 218] File-based per-thread message routing
│       ├── lock.ts          [ 112] File-lock acquisition + recovery
│       └── poller.ts        [ 305] Telegram getUpdates polling loop
│
├── server/                         # Layer 5: Server factory
│   └── factory.ts           [ 303] createMcpServer + per-session state + tool dispatch
│
├── dashboard/                      # Layer 3b: Admin UI
│   ├── spa.html                    Static SPA template
│   ├── routes.ts            [ 290] API endpoint handlers (/api/status, /sessions, etc.)
│   └── presets.ts           [  66] Drive template preset loading
│
└── tools/                          # Layer 4: MCP tool handlers
    ├── definitions.ts       [ 440] JSON schema definitions for all MCP tools
    ├── start-session-tool.ts[ 243] start_session — topic creation, memory bootstrap
    ├── session-tools.ts     [ 324] report_progress, hibernate
    ├── utility-tools.ts     [ 283] send_file, send_voice, send_sticker, schedule_wake_up, etc.
    ├── memory-tools.ts      [ 317] All memory_* tool handlers
    ├── wait-tool.ts         [   5] ← barrel re-export of wait/*
    └── wait/                       # Decomposed wait-for-instructions handler
        ├── index.ts          [   7] Barrel re-export
        ├── poll-loop.ts     [ 330] Main polling orchestrator + SSE keepalive
        ├── message-delivery.ts[326] Format + deliver operator messages
        ├── media-processor.ts[282] Voice/video/GIF/sticker/photo processing
        ├── reaction-handler.ts[139] Reaction wake-up logic
        ├── drive-handler.ts [ 158] Drive activation + Phase 2/3 delivery
        └── task-handler.ts  [  57] Scheduled task firing + __DMN__ sentinel
```

**56 TypeScript files** (up from 24 pre-refactor), organized into 7 directories.

## Layer Hierarchy

The codebase follows a strict 6-layer dependency DAG. Each layer may only import from layers with a lower number.

| Layer | Directory / Files | Responsibility |
|:-----:|-------------------|----------------|
| **0** | `types.ts`, `utils.ts`, `logger.ts`, `intent.ts`, `config.ts` | Pure, zero-dependency modules. No imports from other src/ files (only npm packages). |
| **1** | `integrations/openai/*`, `integrations/telegram/*`, `markdown.ts` | External service clients. Import only Layer 0. |
| **2** | `data/*`, `sessions.ts`, `scheduler.ts` | Data access and persistence. Import Layers 0–1. |
| **3** | `services/*`, `drive.ts`, `response-builders.ts`, `dashboard/*` | Business logic and orchestration. Import Layers 0–2. |
| **4** | `tools/*` | MCP tool handlers. Import Layers 0–3. |
| **5** | `server/factory.ts`, `http-server.ts`, `stdio-server.ts`, `index.ts` | Entrypoints and server bootstrap. Import all layers. |

## Interface Boundaries

Layers communicate through typed interfaces defined in `types.ts` (Layer 0):

- **`AppConfig`** — Immutable configuration object passed down from Layer 5 to all layers.
- **`SessionState`** — Per-session mutable state, created in `server/factory.ts` closure, accessed through getter/setter pairs in tool context objects.
- **`ToolContext`** — Typed context bag passed to every tool handler. Contains service clients, state accessors, config, and helper functions. No handler directly accesses global state.
- **`DashboardCtx`** — Subset of server state exposed to dashboard routes.
- **`CreateMcpServerFn`** — Factory function type used by transport modules to create per-connection server instances.

Each decomposed sub-module (e.g., `tools/wait/*.ts`) defines its own context interface that narrows `ToolContext` to only the fields the handler needs.

## File Size Constraints

- **Target cap**: 300 lines per file.
- **Enforcement**: Planned lint script (`scripts/lint-size`) to check no file exceeds the cap and no circular imports exist.
- **Current status**: Most files are within cap. A few modules remain slightly over 300 lines and are candidates for further splitting in future phases.

## Barrel Re-export Pattern

When a monolithic file was split into a directory of sub-modules, a **barrel re-export stub** was left at the original import path to preserve backward compatibility:

```typescript
// src/memory.ts (8 lines) — barrel stub
export * from "./data/memory/index.js";
```

This allows all existing `import { ... } from "./memory.js"` statements across the codebase to continue working without modification. The same pattern is used for:

- `memory.ts` → `data/memory/*`
- `openai.ts` → `integrations/openai/*`
- `dispatcher.ts` → `services/dispatcher/*`
- `dashboard.ts` → `dashboard/*`
- `tool-definitions.ts` → `tools/definitions`
- `tools/wait-tool.ts` → `tools/wait/*`

New code should import directly from the sub-module path (e.g., `from "./data/memory/semantic.js"`) rather than through the barrel.

## Tool Handler Pattern

Each tool handler is a **pure async function** in its own file under `src/tools/`. Handlers receive a typed context object containing:

- **Session state** accessors (getters/setters for `currentThreadId`, `waitCallCount`, `lastToolCallAt`, etc.)
- **Service clients** (`telegram`, `getMemoryDb`)
- **Config** (the `AppConfig` object)
- **Helper functions** (`resolveThreadId`, `getReminders`, `getShortReminder`, `errorResult`)

The `server/factory.ts` `createMcpServer()` factory:
1. Creates per-session mutable state variables in its closure
2. Registers a `CallToolRequest` handler that dispatches by tool name
3. Constructs the appropriate context object for each handler category
4. Calls the handler and returns its result

The `index.ts` entrypoint is now a thin 46-line shim that reads config, selects transport mode (HTTP or stdio), and delegates to `server/factory.ts`.

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

1. **Tool handlers must be pure functions** — no global mutable state. All state flows through the typed context object constructed in `server/factory.ts` `createMcpServer()`.

2. **Per-session state is isolated** in the `createMcpServer()` closure. Each HTTP session or stdio connection gets its own set of state variables (`waitCallCount`, `currentThreadId`, `lastToolCallAt`, etc.).

3. **All stderr logging goes through `logger.ts`** — writes to both `~/.remote-copilot-mcp/server.log` (with 5 MB rotation) and `process.stderr`.

4. **Default to `"task"` intent** when the classifier is uncertain. This is the safe path — it includes full reminders so the agent has all context needed to act.

5. **Never call MCP tools during maintenance** — when the maintenance flag is detected, the agent must use Desktop Commander `Start-Sleep` to wait externally until the update completes.

6. **Auto-consolidation is fire-and-forget** — never blocks the wait polling loop. Consolidation runs in the background and updates `lastConsolidationAt` on completion.

7. **300-line cap per file** — every TypeScript source file should stay under 300 lines. When a file grows beyond this, extract a sub-module into the appropriate layer directory.

8. **Imports follow the layer DAG** — a module may only import from its own layer or lower layers (Layer 0–5). No upward or circular dependencies.
