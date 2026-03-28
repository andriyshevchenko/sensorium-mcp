# Modular Decomposition Plan — sensorium-mcp

> **This document is fully self-contained.** A fresh agent session with zero conversation history can execute this entire plan by reading only this file. No thread context or memory lookup required.

---

## Execution Protocol (READ THIS FIRST)

### How to Run This Plan

1. **Start session**: Call `start_session` with any available threadId (or create a new one). This is for Telegram reporting only.
2. **Create a feature branch**: `git checkout -b refactor/modular-decomposition`
3. **Read this file** and execute phases 1–7 in order.
4. **After all phases pass**: Create a PR or merge to main.

### Orchestrator Rules

- You are the **ORCHESTRATOR**. ALL code changes (file reads, edits, creation, deletion) MUST go through `runSubagent`.
- Each subagent receives **specific instructions**: source file, function/block to extract, destination file, and expected line count.
- **Never** dispatch a single subagent for an entire phase. Break into per-task subagents.
- Parallel dispatch is allowed ONLY when tasks touch **non-overlapping files**.
- Sequential dispatch when tasks have dependencies (marked in this plan).

### Safety Protocol

1. **Compile after every task**: `cd c:\src\remote-copilot-mcp; npx tsc --noEmit`
2. **If compilation fails**: The subagent must fix it before the task is considered done. If unfixable, revert: `git checkout -- .`
3. **One commit per task**: `git add -A; git commit -m "refactor(phaseN): <description>"`
4. **Barrel re-exports**: When splitting a file (e.g., `memory.ts` → `data/memory/*.ts`), create an `index.ts` barrel that re-exports everything. All existing imports must continue to work unchanged.
5. **No behavior changes**: This is pure refactoring. Zero functional changes.
6. **No version bumps**: Only structural changes.
7. **Push after each completed phase**: `git push origin refactor/modular-decomposition`

### Reporting

- After each phase completes: call `send_voice` with a summary of what was extracted, how many files created, and line counts.
- After final phase: call `send_voice` with the full before/after comparison.

### Workspace

- Path: `c:\src\remote-copilot-mcp`
- Language: TypeScript (Node.js, ESM)
- Build: `npx tsc --noEmit` (type check), `npm run build` (compile to dist/)
- Terminal tool: use `mcp_desktop-comma_start_process` from subagents

---

## Goal
Achieve Linux-kernel-level modularity: strict boundaries, single responsibility per file, <300 LOC per file, explicit typed interfaces, clean DAG dependencies.

## Current State (as of v2.16.29)
- **~8,800 LOC** across 24 TypeScript files
- **7 files over 300 lines** (violating the target cap)
- **1 god function** (`handleWaitForInstructions`: 923 lines in a single function)
- **1 god file** (`memory.ts`: 1666 lines, 6+ responsibilities)
- **1 embedded SPA** (`dashboard.ts`: 833-line HTML generator inline)
- **No circular imports** (clean DAG — good foundation)

## File Size Summary

| File | Lines | Status |
|------|------:|--------|
| memory.ts | 1666 | **CRITICAL** — must split |
| dashboard.ts | 1110 | **CRITICAL** — extract SPA |
| tools/wait-tool.ts | 923 | **CRITICAL** — decompose god function |
| dispatcher.ts | 594 | **HIGH** — split broker + polling |
| openai.ts | 490 | **HIGH** — split by API domain |
| telegram.ts | 490 | **HIGH** — split client + types |
| tool-definitions.ts | 442 | **MEDIUM** — move to data file |
| index.ts | 337 | **MEDIUM** — extract state factory |
| tools/memory-tools.ts | 329 | OK (slightly over) |
| tools/session-tools.ts | 324 | OK (slightly over) |
| All others | <300 | ✅ Within cap |

---

## Architecture: Post-Decomposition Module Map

```
src/
├── core/                    # Layer 0: Pure, zero-dependency modules
│   ├── types.ts             # All shared types and interfaces
│   ├── logger.ts            # File+stderr logging
│   ├── utils.ts             # errorMessage, errorResult, constants
│   ├── intent.ts            # Message intent classification
│   └── config.ts            # Env parsing + validation only
│
├── integrations/            # Layer 1: External service clients
│   ├── telegram/
│   │   ├── client.ts        # TelegramClient class (API methods)
│   │   └── types.ts         # Telegram API type definitions
│   ├── openai/
│   │   ├── chat.ts          # chatCompletion + embedding
│   │   ├── speech.ts        # TTS + Whisper transcription
│   │   ├── vision.ts        # analyzeImage, analyzeVideoFrames
│   │   ├── voice-emotion.ts # Voice analysis service client
│   │   └── video.ts         # extractVideoFrames (ffmpeg)
│   └── markdown.ts          # MD → Telegram format conversion
│
├── data/                    # Layer 2: Data access + persistence
│   ├── memory/
│   │   ├── schema.ts        # SQLite init + migrations
│   │   ├── episodes.ts      # Episode CRUD + batch save
│   │   ├── semantic.ts      # Semantic note CRUD + search
│   │   ├── procedures.ts    # Procedure CRUD
│   │   ├── voice-sig.ts     # Voice signature storage
│   │   ├── search.ts        # Keyword + embedding search
│   │   ├── consolidation.ts # Intelligent consolidation engine
│   │   └── bootstrap.ts     # Session memory briefing assembly
│   ├── sessions.ts          # Name→thread mapping + MCP session registry
│   ├── scheduler.ts         # Schedule CRUD + cron matching
│   ├── templates.ts         # Template file loading + rendering + caching
│   └── file-storage.ts      # Binary file save/cleanup (from config.ts)
│
├── services/                # Layer 3: Business logic + orchestration
│   ├── dispatcher/
│   │   ├── poller.ts        # Telegram getUpdates polling loop
│   │   ├── broker.ts        # File-based per-thread message routing
│   │   └── lock.ts          # File-lock acquisition + recovery
│   ├── drive.ts             # 3-phase probabilistic autonomy
│   └── response-builders.ts # Reminder variants + keyword extraction
│
├── tools/                   # Layer 4: MCP tool handlers
│   ├── definitions.ts       # JSON schema definitions for all tools
│   ├── wait/
│   │   ├── poll-loop.ts     # Main polling loop orchestrator
│   │   ├── message-delivery.ts  # Format + deliver operator messages
│   │   ├── media-processor.ts   # Voice/video/GIF/sticker/photo handling
│   │   ├── reaction-handler.ts  # Reaction wake-up logic
│   │   ├── drive-handler.ts     # Drive activation + Phase 2/3
│   │   └── task-handler.ts      # Scheduled task firing
│   ├── memory-tools.ts      # memory_* tool handlers
│   ├── session-tools.ts     # report_progress handler
│   ├── utility-tools.ts     # send_file, send_voice, send_sticker, etc.
│   └── start-session.ts     # start_session handler
│
├── dashboard/               # Layer 3b: Admin UI
│   ├── routes.ts            # API endpoint handlers
│   ├── spa.html             # Extracted SPA template (static file)
│   └── presets.ts           # Drive template preset loading
│
├── server/                  # Layer 5: Entrypoints
│   ├── factory.ts           # createMcpServer + per-session state + dispatch
│   ├── http.ts              # HTTP/SSE server + CORS + auth
│   └── stdio.ts             # stdio transport bootstrap
│
└── index.ts                 # Entrypoint: startup + mode selection only
```

---

## Implementation Phases

Each phase is independently testable. Phases 1-3 can be parallelized (they touch non-overlapping files). Phase 4+ depends on earlier phases.

### Phase 1: Extract Pure Data / Leaf Modules (Parallel: 3 subagents)

**Goal**: Move non-logic code out first — zero risk.

| Task | From | To | Lines | Agent |
|------|------|----|------:|-------|
| 1A. Extract Telegram types | telegram.ts | integrations/telegram/types.ts | ~60 | Agent A |
| 1B. Extract file storage | config.ts | data/file-storage.ts | ~40 | Agent B |
| 1C. Extract dashboard SPA HTML | dashboard.ts getDashboardHTML() | dashboard/spa.html | ~833 | Agent C |

**Verification**: `npx tsc --noEmit` after each. No behavior changes.

---

### Phase 2: Split memory.ts (Sequential: 7 subagents)

**Goal**: Decompose the 1582-line god file into 8 focused modules.

**Order matters** — schema must exist before CRUD, CRUD before search, search before consolidation.

| Task | Extract | To | Approx Lines | Dependencies |
|------|---------|-----|----------:|-------------|
| 2A. Schema + migrations | `initMemoryDb`, `runMigrations`, `db` handle | data/memory/schema.ts | ~210 | None |
| 2B. Episodes | `saveEpisode`, `getUnconsolidatedEpisodes`, `markEpisodesConsolidated` | data/memory/episodes.ts | ~100 | 2A |
| 2C. Semantic notes | `saveSemanticNote`, `updateSemanticNote`, `supersedeNote`, `getTopSemanticNotes` | data/memory/semantic.ts | ~200 | 2A |
| 2D. Procedures | `saveProcedure`, `updateProcedure`, `getProcedures` | data/memory/procedures.ts | ~100 | 2A |
| 2E. Voice signatures | `saveVoiceSignature`, `getVoiceBaseline`, `getVoiceSignatures` | data/memory/voice-sig.ts | ~80 | 2A |
| 2F. Search | `searchSemanticNotes`, `searchSemanticNotesRanked`, `searchByEmbedding` | data/memory/search.ts | ~180 | 2A, 2C |
| 2G. Consolidation | `runIntelligentConsolidation`, `autoConsolidate` | data/memory/consolidation.ts | ~350 | 2A-2F |
| 2H. Bootstrap | `assembleBootstrap`, `getMemoryStatus`, `forgetMemory`, `getTopicIndex` | data/memory/bootstrap.ts | ~250 | 2A-2F |

**Barrel export**: Create `data/memory/index.ts` that re-exports everything — existing consumers import from `./memory.js` and the barrel keeps them working.

**Verification**: Full compile + manual test of start_session (triggers bootstrap) and memory_save, memory_search.

---

### Phase 3: Split openai.ts (Parallel: 4 subagents)

**Goal**: Separate 6 API integrations into domain-focused modules.

| Task | Extract | To | Lines |
|------|---------|-----|------:|
| 3A. Chat + Embedding | `chatCompletion`, `generateEmbedding`, `cosineSimilarity` | integrations/openai/chat.ts | ~80 |
| 3B. Speech | `textToSpeech`, `transcribeAudio` | integrations/openai/speech.ts | ~90 |
| 3C. Vision | `analyzeImage`, `analyzeVideoFrames` | integrations/openai/vision.ts | ~120 |
| 3D. Voice + Video | `analyzeVoiceEmotion`, `extractVideoFrames` | integrations/openai/voice-emotion.ts + video.ts | ~120 |

**Barrel**: `integrations/openai/index.ts` re-exports all.

---

### Phase 4: Split wait-tool.ts God Function (Sequential: 6 subagents)

**Goal**: Decompose the 896-line function into focused handlers.

**Strategy**: Extract each handler as a standalone async function that receives a typed context object. The main poll-loop calls each handler in sequence.

| Task | Extract | To | Lines |
|------|---------|-----|------:|
| 4A. Poll loop skeleton | Main while loop, SSE keepalive, timeout logic | tools/wait/poll-loop.ts | ~100 |
| 4B. Message delivery | Text/photo/document formatting, content block building | tools/wait/message-delivery.ts | ~200 |
| 4C. Media processor | Voice transcription, video_note, GIF, sticker, photo processing | tools/wait/media-processor.ts | ~250 |
| 4D. Reaction handler | Reaction detection, wake-up, snippet matching | tools/wait/reaction-handler.ts | ~80 |
| 4E. Drive handler | Phase 1 probability gate, Phase 2 delivery, Phase 3 approval | tools/wait/drive-handler.ts | ~60 |
| 4F. Task handler | Scheduled task detection, __DMN__ sentinel | tools/wait/task-handler.ts | ~60 |

**Interface**: Each handler exports a function like:
```typescript
export async function processMedia(
  msg: StoredMessage, 
  ctx: WaitToolContext
): Promise<ContentBlock[]>
```

---

### Phase 5: Split dispatcher.ts + dashboard.ts (Parallel: 2 subagents)

| Task | Extract | To | Lines |
|------|---------|-----|------:|
| 5A. Dispatcher → 3 files | poller, broker, lock | services/dispatcher/*.ts | ~200 each |
| 5B. Dashboard routes → separate from HTML | API handlers, presets | dashboard/routes.ts + presets.ts | ~280 |

---

### Phase 6: Extract Templates + Cleanup (Parallel: 3 subagents)

| Task | Description |
|------|------------|
| 6A. Move template logic | response-builders.ts template functions → data/templates.ts |
| 6B. Slim down index.ts | Extract session state factory + tool dispatch into server/factory.ts |
| 6C. Move tool definitions | tool-definitions.ts → tools/definitions.ts (or JSON file) |

---

### Phase 7: DAG Enforcement + Guardrails

| Task | Description |
|------|------------|
| 7A. Add lint rule | Create a script/lint that checks: no file > 300 lines, no circular imports |
| 7B. tsconfig paths | Configure `@core/*`, `@integrations/*`, `@data/*`, `@services/*`, `@tools/*` path aliases |
| 7C. Update daily review | Add file-size check to daily code review prompt |
| 7D. Update ARCHITECTURE.md | Document the new module map with interfaces |

---

## Execution Strategy

### Subagent Teams Per Phase

| Phase | Parallel Agents | Est. Total Time | Risk |
|-------|:-:|---|---|
| 1 | 3 | 15 min | Very Low — data extraction only |
| 2 | 1-2 (sequential core, parallel periphery) | 45 min | Medium — memory is critical path |
| 3 | 4 | 15 min | Low — clean function boundaries |
| 4 | 1-2 (sequential) | 60 min | **High** — god function decomposition |
| 5 | 2 | 20 min | Low |
| 6 | 3 | 15 min | Low |
| 7 | 3 | 15 min | Very Low — tooling only |

**Total estimated effort**: ~3 hours of agent work (parallelized ~90 min wall clock)

### Safety Rules
1. **Each task compiles before commit.** No partial states.
2. **Barrel re-exports** preserve all existing import paths during transition.
3. **No behavior changes** — pure refactoring. Tests = compile + manual verification.
4. **Each task = 1 commit** with descriptive message.
5. **Rollback**: Each phase is independently revertable via git.

### Orchestrator Workflow
```
for each phase:
  1. Read the tasks in this phase
  2. Identify which tasks can run in parallel (no shared files)
  3. Dispatch subagents with SPECIFIC instructions (file, function, destination)
  4. Wait for all subagents to complete
  5. Run: npx tsc --noEmit (verify clean compile)
  6. Commit all changes for this phase
  7. Push to remote
  8. Report progress
```

---

## Success Criteria

After all phases:
- [ ] No file exceeds 300 lines
- [ ] Every file has a single, clear responsibility
- [ ] All imports follow the Layer 0→5 DAG (no upward dependencies)
- [ ] `npx tsc --noEmit` passes
- [ ] All MCP tools function identically to pre-refactor
- [ ] Daily code review enforcement in place

## Expected Final File Count
~40-45 files (up from 24), each under 300 lines, with clear module boundaries matching the Linux kernel principle: **you can understand any file in isolation**.
