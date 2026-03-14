# Sensorium Memory System — Architecture Design Document

> **Multi-layer, self-improving memory for indefinite MCP agent operation**
>
> Version: 1.0 — March 14, 2026
> Project: `remote-copilot-mcp` (Sensorium MCP)

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Architecture Overview](#2-architecture-overview)
3. [Layer 1 — Working Memory](#3-layer-1--working-memory)
4. [Layer 2 — Episodic Memory](#4-layer-2--episodic-memory)
5. [Layer 3 — Semantic Memory](#5-layer-3--semantic-memory)
6. [Layer 4 — Procedural Memory](#6-layer-4--procedural-memory)
7. [Layer 5 — Meta-Memory](#7-layer-5--meta-memory)
8. [Multimodal Data Handling](#8-multimodal-data-handling)
9. [Consolidation Process (Sleep Cycle)](#9-consolidation-process-sleep-cycle)
10. [Session Bootstrap](#10-session-bootstrap)
11. [MCP Tool Surface](#11-mcp-tool-surface)
12. [Storage Backend — Unified Schema](#12-storage-backend--unified-schema)
13. [Lifecycle of a Memory](#13-lifecycle-of-a-memory)
14. [Failure Modes & Mitigations](#14-failure-modes--mitigations)
15. [Migration Path from Existing Systems](#15-migration-path-from-existing-systems)
16. [Open Questions](#16-open-questions)

---

## 1. Design Philosophy

### Lessons Learned from Failed Attempts

| System | What failed | Root cause |
|---|---|---|
| `atomic-memory-mcp` (26-tool knowledge graph) | Event logs grow unbounded; agent dumps too much into context | No promotion/demotion between layers; flat storage |
| `mcp-memory-graph-enhanced` (Neo4j) | Temporal coherence loss; heavy infrastructure | Graph edges lack aging; no consolidation; Neo4j is overkill for single-user |
| Raw conversation history | Session crashes from context overflow (`thinking/redacted_thinking` compaction bug) | No external state; everything lives inside the context window |

### Core Principles

1. **Never dump — always query.** Memory tools return *targeted slices*, not entire stores. The agent asks for what it needs.
2. **Memories have a lifecycle.** Raw events → consolidated facts → procedural habits → eventual decay. Nothing is permanent by default.
3. **External state is the source of truth.** The context window is a *cache*. SQLite on disk is the *store*. Crashes lose nothing.
4. **The agent is the memory manager.** Following Mem0/MemGPT: the LLM decides what to remember, what to forget, and when to consolidate. Automatic processes handle the bookkeeping.
5. **Token budget is sacred.** Every memory retrieval has a budget. The system enforces it, not the agent's self-discipline.
6. **Multimodal from day one.** Voice tone, speech patterns, video scene descriptions, and image contexts are first-class memories — not afterthoughts.
7. **Sleep is productive.** Idle time (operator silence between `wait_for_instructions` polls) triggers consolidation, not just waiting.

### Architecture Influences

| Source | What we take |
|---|---|
| **HiMem** (Jan 2026) | Episode Memory + Note Memory dual-layer; conflict-aware reconsolidation |
| **A-Mem** (NeurIPS 2025) | Zettelkasten dynamic linking between notes; 85-93% token reduction |
| **Mem0** | LLM-as-memory-manager; three-tier storage; audit trail |
| **MemGPT/Letta** | Agent-controlled memory paging; core memory self-editing |
| **Sleeping LLM** | Wake/sleep cycle concept (adapted: we consolidate *data structures*, not model weights) |
| **Hindsight** (Dec 2025) | Strict separation between evidence (raw), knowledge (extracted), and reasoning (agent) |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     CONTEXT WINDOW (cache)                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │            Layer 1: WORKING MEMORY                        │  │
│  │  Session briefing + active task context + recent turns    │  │
│  │  Budget: ~4,000 tokens                                    │  │
│  └───────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                     SQLITE DATABASE (disk)                      │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐           │
│  │  Layer 2:   │  │  Layer 3:   │  │  Layer 4:    │           │
│  │  EPISODIC   │  │  SEMANTIC   │  │  PROCEDURAL  │           │
│  │  Raw events │  │  Facts &    │  │  Workflows & │           │
│  │  with meta  │  │  patterns   │  │  habits      │           │
│  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘           │
│         │                │                │                     │
│  ┌──────┴────────────────┴────────────────┴───────┐            │
│  │          Layer 5: META-MEMORY                   │            │
│  │  What the agent knows it knows (indexes,        │            │
│  │  retrieval stats, confidence calibration)        │            │
│  └─────────────────────────────────────────────────┘            │
│                                                                 │
│  ┌─────────────────────────────────────────────────┐            │
│  │          CONSOLIDATION ENGINE                    │            │
│  │  Runs during idle (sleep cycle via scheduler)    │            │
│  └─────────────────────────────────────────────────┘            │
│                                                                 │
│  ┌─────────────────────────────────────────────────┐            │
│  │          MULTIMODAL STORE                        │            │
│  │  Voice signatures, scene descriptions, files     │            │
│  └─────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Operator message (text/voice/photo/video)
    │
    ▼
┌──────────────────────┐
│ INGEST (automatic)   │  Writes raw event → Layer 2 (Episodic)
│ Extracts modality    │  Extracts voice analysis → Multimodal Store
│ metadata             │  Timestamps everything
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ AGENT PROCESSING     │  Agent reads operator message
│ (wake state)         │  Agent calls memory tools as needed
│                      │  Agent writes observations → Layer 3
│                      │  Agent updates workflows → Layer 4
└──────────┬───────────┘
           │
           ▼ (operator goes silent)
┌──────────────────────┐
│ CONSOLIDATION        │  Promote Episode → Semantic (extract facts)
│ (sleep state)        │  Merge duplicate semantics
│                      │  Detect patterns → Procedural
│                      │  Decay old, low-access memories
│                      │  Update meta-memory indexes
└──────────────────────┘
```

---

## 3. Layer 1 — Working Memory

### Purpose

The in-context session briefing. Loaded at session start, updated as the session progresses. This is the only layer that lives *inside* the LLM context window.

### What Gets Stored

```jsonc
{
  "session_id": "sess_20260314_143022",
  "thread_id": 4821,
  "started_at": "2026-03-14T14:30:22Z",
  "operator_profile": {
    // From Layer 3 — top-5 most relevant semantic memories
    "name": "Andrii",
    "preferences": ["prefers voice interaction", "works in TypeScript/Python", "night owl — most active 22:00-03:00"],
    "current_mood_trend": "focused, moderate energy (last 3 voice messages)",
    "active_projects": ["remote-copilot-mcp", "voice-analysis service"]
  },
  "active_context": {
    // What we're currently working on — from Layer 4
    "current_task": "Design memory system architecture",
    "recent_decisions": [
      "Chose SQLite over Neo4j for simplicity",
      "Five-layer architecture approved"
    ]
  },
  "session_history_summary": "Session resumed from crash. Previously discussed memory design requirements. Operator provided research comparison document.",
  "pending_observations": [
    // Buffered facts not yet written to Layer 3 (written on next consolidation or explicit save)
  ]
}
```

### How It Gets Written

| Trigger | Writer | What |
|---|---|---|
| Session start | **Automatic** (bootstrap process) | Assembled from Layers 2-5 via `memory_bootstrap` |
| Each operator message | **Automatic** (ingest) | Appended to `pending_observations` |
| Agent decides something | **Agent** (explicit tool call) | Updates `active_context` |
| Consolidation | **Automatic** | Flushes `pending_observations` → Layer 3 |

### How It Gets Retrieved

Working memory IS the context. No retrieval needed — it's already there.

### How It Ages

- `pending_observations` flush to Layer 3 every consolidation cycle or when buffer exceeds 10 items.
- `session_history_summary` is rewritten by the consolidation engine when session exceeds 50 turns (LLM-generated summary of older episodes).
- On session restart, the entire working memory is rebuilt from persistent layers.

### Storage Backend

**Not persisted as a separate entity.** It's assembled on-the-fly from Layers 2-5 during bootstrap. The only persisted piece is the list of `pending_observations` (saved to SQLite `working_buffer` table on each write, so they survive crashes).

```sql
CREATE TABLE working_buffer (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  thread_id   INTEGER NOT NULL,
  content     TEXT NOT NULL,        -- JSON blob
  created_at  TEXT NOT NULL,        -- ISO 8601
  flushed     INTEGER DEFAULT 0     -- 1 = promoted to Layer 3
);
```

### Token Budget

**Hard limit: 4,000 tokens.** The bootstrap process enforces this. If the assembled briefing exceeds the budget, it prioritizes:
1. Operator identity + mood (always included, ~200 tokens)
2. Current task + recent decisions (~500 tokens)
3. Top semantic memories by relevance score (~1,500 tokens)
4. Session summary (~800 tokens)
5. Pending observations (remaining budget)

---

## 4. Layer 2 — Episodic Memory

### Purpose

Time-stamped log of raw events — what happened, when, in what context. The "ground truth" layer. Everything enters memory through here first.

### What Gets Stored

Each episode is a discrete event (one operator message, one agent action, one system event):

```jsonc
{
  "episode_id": "ep_20260314_143055_a7f2",
  "session_id": "sess_20260314_143022",
  "thread_id": 4821,
  "timestamp": "2026-03-14T14:30:55Z",
  "type": "operator_message",           // operator_message | agent_action | system_event
  "modality": "voice",                  // text | voice | photo | video_note | document | mixed
  "content": {
    "text": "I want you to design a memory system",
    "raw_transcript": "I want you to design a memory system",  // original Whisper output
    "voice_analysis": {
      "emotion": "neutral",
      "arousal": 0.23,
      "dominance": 0.31,
      "valence": 0.28,
      "gender": "male",
      "speech_rate": 4.2,
      "mean_pitch_hz": 142,
      "audio_events": ["keyboard typing (78%)"]
    },
    "scene_description": null            // populated for video_note
  },
  "topic_tags": ["memory", "architecture", "design"],  // auto-extracted
  "importance": 0.8,                     // 0.0-1.0, LLM-assigned during ingest
  "consolidated": false,                 // true once promoted to Layer 3
  "accessed_count": 0,                   // how many times retrieved
  "last_accessed_at": null
}
```

### How It Gets Written

| Trigger | Writer | Details |
|---|---|---|
| Every operator message | **Automatic** | The `wait_for_instructions` handler writes to episodic memory before returning content to the agent |
| Every agent action | **Automatic** | `report_progress`, `send_file`, `send_voice` calls log an episode |
| System events | **Automatic** | Session start/resume, crashes, consolidation runs |

**The agent never writes to episodic memory directly.** This is the evidence layer (per Hindsight paper — strict separation).

### How It Gets Retrieved

1. **Recency query**: Last N episodes for a thread (default N=20)
2. **Time-range query**: Episodes between timestamp A and B
3. **Topic search**: FTS5 full-text search on `content.text` + `topic_tags`
4. **Modality filter**: "Show me all voice messages from the last week"
5. **Importance threshold**: Only episodes with importance ≥ X

Retrieval always returns a **token-budgeted** slice. The tool enforces a max of 2,000 tokens per retrieval call. Results are sorted by `(relevance × recency × importance)` composite score.

### How It Ages / Consolidates

```
                        ┌──────────────────────┐
                        │    EPISODE            │
                        │    (importance: 0.8,  │
                        │     age: 2h)          │
                        └──────────┬───────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
     importance ≥ 0.5      importance < 0.5     age > 30 days
     AND age > 6h         AND age > 24h         regardless
              │                    │                    │
              ▼                    ▼                    ▼
    PROMOTE to Layer 3      DECAY importance       ARCHIVE
    (extract facts,         by 0.1 per day         (compress to
     mark consolidated)                             summary, move
                                                    to cold store)
```

**Decay formula:**

```
effective_importance = base_importance × (0.95 ^ days_since_creation) × (1 + 0.1 × access_count)
```

- Base importance decays with a half-life of ~14 days
- Each access boosts effective importance by 10% (accessed memories resist decay)
- Episodes that were promoted to Layer 3 are marked `consolidated = true` but NOT deleted (evidence preservation per Hindsight)

**Archive threshold:** Episodes older than 30 days with `effective_importance < 0.2` and `consolidated = true` are moved to an archive table (compressed, not queryable by default, but recoverable).

### Storage Backend

```sql
CREATE TABLE episodes (
  episode_id     TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  thread_id      INTEGER NOT NULL,
  timestamp      TEXT NOT NULL,           -- ISO 8601
  type           TEXT NOT NULL,           -- operator_message, agent_action, system_event
  modality       TEXT NOT NULL,           -- text, voice, photo, video_note, document, mixed
  content        TEXT NOT NULL,           -- JSON blob (text, voice_analysis, scene_description)
  topic_tags     TEXT,                    -- JSON array, also indexed in FTS
  importance     REAL NOT NULL DEFAULT 0.5,
  consolidated   INTEGER DEFAULT 0,
  accessed_count INTEGER DEFAULT 0,
  last_accessed  TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_episodes_thread_time ON episodes(thread_id, timestamp DESC);
CREATE INDEX idx_episodes_importance ON episodes(importance DESC);
CREATE INDEX idx_episodes_consolidated ON episodes(consolidated);

-- Full-text search on episode content
CREATE VIRTUAL TABLE episodes_fts USING fts5(
  episode_id,
  text_content,
  topic_tags,
  content='episodes',
  content_rowid='rowid'
);
```

---

## 5. Layer 3 — Semantic Memory

### Purpose

Distilled, de-duplicated knowledge extracted from episodes. Facts, preferences, patterns, entity relationships. This is the "what the agent knows" layer — structured knowledge, not raw events.

Inspired by A-Mem's Zettelkasten: each semantic memory is a **note** with dynamic links to related notes.

### What Gets Stored

```jsonc
{
  "note_id": "sem_a3f8c2",
  "type": "fact",                        // fact | preference | pattern | entity | relationship
  "content": "Andrii prefers voice interaction over text for casual updates, but wants text for technical details",
  "keywords": ["voice", "communication", "preference"],
  "confidence": 0.9,                     // 0.0-1.0
  "source_episodes": ["ep_20260314_143055_a7f2", "ep_20260312_221033_b1c4"],  // evidence trail
  "linked_notes": ["sem_b7d1a9", "sem_c2e5f3"],   // A-Mem dynamic links
  "link_reasons": {
    "sem_b7d1a9": "same topic: communication preferences",
    "sem_c2e5f3": "contradicts: earlier preference for text-only"
  },
  "valid_from": "2026-03-12T22:10:33Z",  // temporal validity (from Graphiti)
  "valid_to": null,                       // null = still current
  "superseded_by": null,                  // note_id that replaced this, if any
  "access_count": 5,
  "last_accessed_at": "2026-03-14T14:30:55Z",
  "created_at": "2026-03-12T23:00:00Z",  // when consolidation created this
  "updated_at": "2026-03-14T14:35:00Z"
}
```

### Memory Types

| Type | Description | Example |
|---|---|---|
| `fact` | Atomic factual statement | "The project uses TypeScript with ESM modules" |
| `preference` | Operator preference or habit | "Andrii prefers nova voice for TTS" |
| `pattern` | Recurring pattern observed across episodes | "Operator sends voice messages when walking (background noise: street, wind)" |
| `entity` | A named entity with properties | "remote-copilot-mcp: TypeScript MCP server, v2.6.4, MIT license" |
| `relationship` | Directed relationship between entities | "voice-analysis → deployed_on → Azure Container Apps" |

### How It Gets Written

| Trigger | Writer | Details |
|---|---|---|
| Consolidation (sleep cycle) | **Automatic** | LLM extracts facts from unconsolidated episodes |
| Agent explicit save | **Agent** (via `memory_save` tool) | Agent notices something worth remembering mid-conversation |
| Conflict resolution | **Automatic** | When new fact contradicts existing note → supersede old, create new (HiMem-style) |

**Extraction prompt** (used by consolidation engine):

```
Given these recent episodes, extract atomic facts, preferences, and patterns.
For each extraction:
1. State the fact in one clear sentence
2. Assign confidence (0.0-1.0) based on evidence strength
3. List keywords for retrieval
4. Identify if this UPDATES, CONTRADICTS, or is NEW relative to existing notes

Existing notes (potentially affected):
{top_10_related_notes}

Episodes to process:
{unconsolidated_episodes}
```

### How It Gets Retrieved

**Hybrid retrieval** (adapted from Mem0):

1. **Keyword match**: FTS5 search on `content` + `keywords` (fast, recall-oriented)
2. **Linked-note traversal**: When a note is retrieved, its `linked_notes` are candidates for inclusion (A-Mem graph walk, depth=2)
3. **Recency + access boost**: Notes accessed recently or frequently rank higher
4. **Type filter**: Agent can request only `preferences`, only `facts`, etc.

**Scoring formula:**

```
score = (keyword_relevance × 0.4) + (recency × 0.2) + (access_frequency × 0.15) + (confidence × 0.15) + (link_proximity × 0.1)
```

Where:
- `keyword_relevance`: FTS5 rank score (BM25)
- `recency`: `1 / (1 + days_since_last_access)`
- `access_frequency`: `min(1.0, access_count / 20)`
- `confidence`: stored confidence value
- `link_proximity`: 1.0 if direct link from a previously-retrieved note, 0.5 if 2-hop, 0 otherwise

**Budget enforcement:** Every retrieval call specifies a token budget (default: 1,500 tokens). Results are ranked by score, and the top-K that fit within budget are returned.

### How It Ages / Consolidates

```
                    ┌─────────────────────┐
                    │   SEMANTIC NOTE     │
                    │   (confidence: 0.9) │
                    └──────────┬──────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
  accessed ≥ 5×          never accessed          contradicted by
  in 30 days             in 60 days              newer evidence
         │                     │                     │
         ▼                     ▼                     ▼
  STRENGTHEN              DECAY                  SUPERSEDE
  (confidence ×1.1,       (confidence ×0.8,       (set valid_to,
   promote to             set valid_to if          link superseded_by,
   working memory         confidence < 0.3)        create replacement)
   if important)
```

**Merge process** (during consolidation):
- Notes with cosine-similar content (via FTS5 BM25 rank > threshold) are candidates for merging
- LLM decides: MERGE (combine into one stronger note), KEEP_BOTH (different aspects), or SUPERSEDE (one replaces the other)

### Storage Backend

```sql
CREATE TABLE semantic_notes (
  note_id        TEXT PRIMARY KEY,
  type           TEXT NOT NULL,            -- fact, preference, pattern, entity, relationship
  content        TEXT NOT NULL,
  keywords       TEXT NOT NULL,            -- JSON array
  confidence     REAL NOT NULL DEFAULT 0.5,
  source_episodes TEXT,                    -- JSON array of episode_ids
  linked_notes   TEXT,                     -- JSON array of note_ids
  link_reasons   TEXT,                     -- JSON object {note_id: reason}
  valid_from     TEXT NOT NULL,
  valid_to       TEXT,                     -- NULL = current
  superseded_by  TEXT,                     -- note_id or NULL
  access_count   INTEGER DEFAULT 0,
  last_accessed  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_semantic_type ON semantic_notes(type);
CREATE INDEX idx_semantic_confidence ON semantic_notes(confidence DESC);
CREATE INDEX idx_semantic_valid ON semantic_notes(valid_to);  -- NULL = current

CREATE VIRTUAL TABLE semantic_fts USING fts5(
  note_id,
  content,
  keywords,
  content='semantic_notes',
  content_rowid='rowid'
);
```

---

## 6. Layer 4 — Procedural Memory

### Purpose

Learned workflows, operator habits, tool-use patterns, and task templates. "How things are done" — not facts, but *procedures*.

### What Gets Stored

```jsonc
{
  "procedure_id": "proc_deploy_voice_analysis",
  "name": "Deploy voice-analysis service to Azure",
  "type": "workflow",                    // workflow | habit | tool_pattern | template
  "description": "Steps to deploy the voice-analysis Python service to Azure Container Apps",
  "steps": [
    "1. Build Docker image: docker build -t voice-analysis ./voice-analysis",
    "2. Push to ACR: az acr build --registry sensoriumacr --image voice-analysis:latest ./voice-analysis",
    "3. Update Container App: az containerapp update --name voice-analysis --resource-group sensorium-rg --image sensoriumacr.azurecr.io/voice-analysis:latest",
    "4. Verify warmup: curl https://voice-analysis.example.com/health",
    "5. Report to operator: deployment complete + health check result"
  ],
  "trigger_conditions": ["operator says 'deploy voice'", "CI pipeline fails for voice-analysis"],
  "success_rate": 0.85,                 // historical success when following this procedure
  "times_executed": 7,
  "last_executed_at": "2026-03-13T02:15:00Z",
  "learned_from_episodes": ["ep_20260301_...", "ep_20260305_..."],
  "operator_corrections": [
    {
      "episode_id": "ep_20260308_...",
      "correction": "Always check if ACR login is fresh before pushing",
      "applied": true
    }
  ],
  "related_procedures": ["proc_check_ci", "proc_azure_login"],
  "confidence": 0.9,
  "created_at": "2026-03-02T00:00:00Z",
  "updated_at": "2026-03-13T02:15:00Z"
}
```

### Memory Types

| Type | Description | Example |
|---|---|---|
| `workflow` | Multi-step procedure for a recurring task | Deploy service, fix CI, publish npm package |
| `habit` | Operator behavioral pattern | "Andrii reviews PRs in the morning, codes at night" |
| `tool_pattern` | Learned tool usage preference | "Use subagents for file edits, not inline" |
| `template` | Reusable response/report format | "Progress report format: bullet list with emoji status" |

### How It Gets Written

| Trigger | Writer | Details |
|---|---|---|
| Agent recognizes a repeated pattern | **Agent** (via `memory_save_procedure`) | After completing the same type of task 2+ times |
| Consolidation detects repeated episode sequences | **Automatic** | Pattern detection during sleep cycle |
| Operator correction | **Agent** | When operator says "no, do it this way" → update existing procedure |

### How It Gets Retrieved

1. **Trigger matching**: When a new task arrives, the agent can query "do I have a procedure for this?" — fuzzy match on `trigger_conditions` and `name`
2. **Explicit recall**: Agent calls `memory_recall_procedure` with a description
3. **Proactive suggestion**: During bootstrap, top 3 most-used procedures are summarized in working memory

### How It Ages

- `success_rate` is updated after each execution (exponential moving average)
- Procedures with `success_rate < 0.5` after `times_executed > 5` are flagged for review
- Procedures not executed in 90 days have confidence decayed by 0.1 per month
- Operator corrections always increase confidence (the procedure is improving)

### Storage Backend

```sql
CREATE TABLE procedures (
  procedure_id       TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL,       -- workflow, habit, tool_pattern, template
  description        TEXT NOT NULL,
  steps              TEXT,                -- JSON array (NULL for habits/patterns)
  trigger_conditions TEXT,                -- JSON array
  success_rate       REAL DEFAULT 0.5,
  times_executed     INTEGER DEFAULT 0,
  last_executed_at   TEXT,
  learned_from       TEXT,                -- JSON array of episode_ids
  corrections        TEXT,                -- JSON array of correction objects
  related_procedures TEXT,                -- JSON array of procedure_ids
  confidence         REAL DEFAULT 0.5,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE VIRTUAL TABLE procedures_fts USING fts5(
  procedure_id,
  name,
  description,
  trigger_conditions,
  content='procedures',
  content_rowid='rowid'
);
```

---

## 7. Layer 5 — Meta-Memory

### Purpose

Memory about memory. Indexes what the agent knows, tracks retrieval effectiveness, and calibrates confidence. This layer enables the agent to answer "do I know anything about X?" without actually searching — and to know when its memories are stale or unreliable.

### What Gets Stored

```jsonc
{
  // Topic index — what domains have memories
  "topic_index": {
    "azure-deployment": {
      "semantic_count": 12,
      "procedural_count": 3,
      "last_updated": "2026-03-13T02:15:00Z",
      "avg_confidence": 0.82,
      "total_accesses": 45
    },
    "operator-preferences": {
      "semantic_count": 8,
      "procedural_count": 1,
      "last_updated": "2026-03-14T14:35:00Z",
      "avg_confidence": 0.91,
      "total_accesses": 120
    }
  },

  // Retrieval performance tracking
  "retrieval_stats": {
    "total_queries": 342,
    "successful_retrievals": 298,        // agent used the result
    "failed_retrievals": 44,             // agent ignored or re-queried
    "avg_tokens_per_retrieval": 890,
    "most_queried_topics": ["operator-preferences", "project-structure", "deployment"]
  },

  // Confidence calibration
  "confidence_calibration": {
    // Tracks: when the agent was confident, was it right?
    "high_confidence_correct": 145,      // confidence > 0.8 AND operator didn't correct
    "high_confidence_incorrect": 8,      // confidence > 0.8 AND operator corrected
    "calibration_score": 0.95            // 145 / (145 + 8)
  },

  // Consolidation history
  "consolidation_log": [
    {
      "run_at": "2026-03-14T05:00:00Z",
      "episodes_processed": 23,
      "notes_created": 7,
      "notes_merged": 2,
      "notes_superseded": 1,
      "procedures_updated": 1,
      "duration_ms": 4500
    }
  ]
}
```

### How It Gets Written

**Entirely automatic.** The meta-memory layer is maintained by the memory system infrastructure, not the agent.

| Trigger | What happens |
|---|---|
| Any memory retrieval | Increment access counts, update `retrieval_stats` |
| Consolidation run | Update `topic_index`, append to `consolidation_log` |
| Operator correction | Update `confidence_calibration` |
| Note created/superseded | Update `topic_index` counts |

### How It Gets Retrieved

The agent has one meta-memory tool: `memory_status`. It returns:
1. Topics the agent has knowledge about (with confidence levels)
2. Time since last consolidation
3. Memory health metrics (stale note count, pending episodes, storage size)

This is cheap (~300 tokens) and included in every session bootstrap.

### Storage Backend

```sql
CREATE TABLE meta_topic_index (
  topic           TEXT PRIMARY KEY,
  semantic_count  INTEGER DEFAULT 0,
  procedural_count INTEGER DEFAULT 0,
  last_updated    TEXT,
  avg_confidence  REAL DEFAULT 0.5,
  total_accesses  INTEGER DEFAULT 0
);

CREATE TABLE meta_retrieval_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT NOT NULL,
  query_text      TEXT,
  layer           TEXT,              -- episodic, semantic, procedural
  results_count   INTEGER,
  tokens_used     INTEGER,
  was_useful      INTEGER DEFAULT 1  -- 0 if agent re-queried immediately
);

CREATE TABLE meta_consolidation_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at              TEXT NOT NULL,
  episodes_processed  INTEGER,
  notes_created       INTEGER,
  notes_merged        INTEGER,
  notes_superseded    INTEGER,
  procedures_updated  INTEGER,
  duration_ms         INTEGER
);

CREATE TABLE meta_confidence (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL,
  note_id    TEXT,
  confidence REAL,
  was_correct INTEGER  -- 1 or 0
);
```

---

## 8. Multimodal Data Handling

### Design Principle

Raw binary data (audio, video, images) is **never stored in the memory database**. Instead:
1. Binary files are saved to disk (existing `~/.remote-copilot-mcp/files/` directory)
2. **Structured metadata** is stored in the memory system as part of episodes and semantic notes
3. The voice-analysis microservice (already deployed) provides emotion/paralinguistic features

### Voice Memory

The existing voice analysis pipeline (`openai.ts` → `analyzeVoiceEmotion`) already extracts rich metadata. This data flows into memory as follows:

```
Voice message (OGG Opus)
    │
    ├── Whisper transcription → text into episode.content.text
    │
    ├── Voice analysis (VANPY) → episode.content.voice_analysis
    │   {emotion, arousal, dominance, valence, gender, speech_rate, pitch, audio_events}
    │
    └── Audio file → disk: ~/.remote-copilot-mcp/files/voice_<timestamp>.ogg
        (path stored in episode.content.file_path)
```

**Voice pattern tracking** (promoted to Layer 3 during consolidation):

```jsonc
// Semantic note of type "pattern"
{
  "note_id": "sem_voice_pattern_001",
  "type": "pattern",
  "content": "Operator's voice is typically calm and reserved (arousal: 0.18-0.25, valence: 0.22-0.30) during normal conversation. When excited about a feature, arousal jumps to 0.45+ and speech rate increases from ~4.0 to ~5.5 syl/s. Frustration manifests as lower valence (<0.15) with maintained arousal.",
  "keywords": ["voice", "emotion", "pattern", "operator"],
  "confidence": 0.85,
  "source_episodes": ["ep_...", "ep_...", "ep_..."]  // 10+ voice episodes analyzed
}
```

**Voice signature table** (dedicated multimodal store):

```sql
CREATE TABLE voice_signatures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id      TEXT NOT NULL REFERENCES episodes(episode_id),
  emotion         TEXT,
  arousal         REAL,
  dominance       REAL,
  valence         REAL,
  speech_rate     REAL,
  mean_pitch_hz   REAL,
  pitch_std_hz    REAL,
  jitter          REAL,
  shimmer         REAL,
  hnr_db          REAL,
  audio_events    TEXT,           -- JSON array
  duration_sec    REAL,
  file_path       TEXT,           -- disk path to OGG file
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_voice_episode ON voice_signatures(episode_id);
CREATE INDEX idx_voice_time ON voice_signatures(created_at DESC);
```

### Video Memory

Uses the existing `extractVideoFrames` → `analyzeVideoFrames` pipeline:

```
Video note (MP4)
    │
    ├── Frame extraction (ffmpeg) → GPT-5-mini vision analysis → episode.content.scene_description
    │
    ├── Audio track → Whisper transcription → episode.content.text
    │
    ├── Audio track → Voice analysis → episode.content.voice_analysis
    │
    └── Video file → disk: ~/.remote-copilot-mcp/files/video_<timestamp>.mp4
```

**Scene description** is stored as text in the episode and can be promoted to semantic notes during consolidation (e.g., "Operator's workspace has dual monitors, mechanical keyboard, consistently works from a home office").

### Image Memory

```
Photo (JPEG/PNG)
    │
    ├── Image file → disk: ~/.remote-copilot-mcp/files/photo_<timestamp>.jpg
    │
    ├── Caption (if any) → episode.content.text
    │
    └── Image description (future: GPT-5-mini vision) → episode.content.scene_description
```

### Multimodal Consolidation Patterns

During the sleep cycle, the consolidation engine looks for patterns across modalities:

| Pattern type | Detection method | Example output |
|---|---|---|
| Emotional baseline | Average voice_signatures over 20+ samples | "Operator's neutral state: arousal=0.21, valence=0.26, pitch=142Hz" |
| Mood shift | Compare recent 5 voice signatures to baseline | "Operator mood shifted: increased arousal (+0.15) and lower valence (-0.08) over last 3 messages — possible frustration" |
| Environment patterns | Cluster audio_events across episodes | "Operator frequently works with keyboard sounds and fan noise (home office). Occasional outdoor sessions (street noise, wind)" |
| Communication preferences | Correlate modality with topic type | "Technical discussions: text. Quick updates: voice. Showing bugs: screenshots/video notes" |

---

## 9. Consolidation Process (Sleep Cycle)

### Integration with Existing Scheduler

The consolidation process piggybacks on the existing `scheduler.ts` infrastructure. It runs as a scheduled task triggered by operator inactivity.

```
┌─────────────────────────────────────────────────────────────┐
│            SCHEDULER (already exists)                        │
│                                                             │
│  schedule_wake_up(afterIdleMinutes: 30, prompt: ...)        │
│     │                                                       │
│     ▼                                                       │
│  Operator silent for 30 min                                 │
│     │                                                       │
│     ▼                                                       │
│  CONSOLIDATION ENGINE fires                                 │
│     │                                                       │
│     ├── Phase 1: Episode → Semantic promotion               │
│     ├── Phase 2: Semantic deduplication & merge             │
│     ├── Phase 3: Pattern → Procedural extraction            │
│     ├── Phase 4: Decay & archive                            │
│     ├── Phase 5: Meta-memory update                         │
│     └── Phase 6: Voice pattern recalculation                │
│                                                             │
│  Total budget: 1 LLM call per phase (~6 calls)             │
│  Target duration: < 30 seconds                              │
└─────────────────────────────────────────────────────────────┘
```

### Phase Details

#### Phase 1: Episode → Semantic Promotion (the "hippocampus → neocortex" transfer)

```
Input:  All episodes where consolidated = false AND age > 6 hours AND importance ≥ 0.5
        (batched: max 20 episodes per consolidation run)

Process:
  1. Retrieve relevant existing semantic notes (top 10 by keyword overlap with episode batch)
  2. LLM extraction call:
     "Given these episodes and existing knowledge, extract new or updated facts."
     → Returns: list of {action: CREATE|UPDATE|SUPERSEDE, note content, links}
  3. For each CREATE: insert new semantic note, compute links to existing notes
  4. For each UPDATE: modify existing note, bump confidence, add source episodes
  5. For each SUPERSEDE: set valid_to on old note, create replacement, link via superseded_by
  6. Mark processed episodes as consolidated = true

Output: N new/updated semantic notes
Token cost: ~2,000 input + ~500 output = ~2,500 tokens per batch
```

#### Phase 2: Semantic Deduplication & Merge

```
Input:  Semantic notes updated in last 7 days with overlapping keywords

Process:
  1. For each recently-updated note, find notes with FTS5 BM25 rank > 0.7
  2. Group candidates into potential merge clusters
  3. LLM merge call:
     "These notes may be duplicates or complementary. For each pair, decide: MERGE, KEEP_BOTH, or SUPERSEDE."
  4. Execute merges: combine content, union source_episodes, average confidence, re-link

Output: Reduced note count, higher-quality notes
Token cost: ~1,500 tokens per run
```

#### Phase 3: Pattern → Procedural Extraction

```
Input:  Consolidated episodes from last 30 days, grouped by topic_tags

Process:
  1. Identify episode sequences that repeat (same topic tags, similar actions)
  2. If a sequence appears 2+ times: candidate for procedural memory
  3. LLM call: "These episode sequences show a repeated workflow. Extract the procedure."
  4. Create or update procedural memory entry
  5. Cross-reference with existing procedures to avoid duplicates

Output: New/updated procedures
Token cost: ~2,000 tokens (only runs when patterns detected; most runs skip this phase)
```

#### Phase 4: Decay & Archive

```
Input:  All memories across layers

Process (no LLM needed — pure computation):
  1. Recalculate effective_importance for all episodes
  2. Recalculate confidence for all semantic notes (based on age, access, calibration)
  3. Archive episodes: consolidated = true AND age > 30 days AND effective_importance < 0.2
  4. Mark expired semantic notes: confidence < 0.2 AND last_accessed > 60 days ago → set valid_to
  5. Flag failing procedures: success_rate < 0.5 AND times_executed > 5

Output: Archived/expired counts
Token cost: 0 (computational only)
```

#### Phase 5: Meta-Memory Update

```
Process (no LLM needed):
  1. Rebuild topic_index from current semantic + procedural entries
  2. Update retrieval_stats aggregations
  3. Recalculate confidence_calibration
  4. Append consolidation_log entry

Token cost: 0
```

#### Phase 6: Multimodal Pattern Recalculation

```
Input:  Voice signatures from last 30 days

Process (no LLM needed for baseline; 1 LLM call for pattern description):
  1. Compute running averages for arousal, valence, dominance, pitch, speech_rate
  2. Detect outliers (> 2σ from rolling mean)
  3. Cluster audio_events by frequency
  4. If patterns changed significantly: LLM call to update voice pattern semantic note

Output: Updated voice baseline, possibly updated pattern note
Token cost: 0-1,500 tokens (usually 0)
```

### Consolidation Scheduling

The agent should schedule consolidation during `start_session`:

```javascript
// Automatically set up by memory system on session start
schedule_wake_up({
  label: "memory-consolidation",
  afterIdleMinutes: 30,
  prompt: "[SYSTEM] Run memory consolidation cycle. Call memory_consolidate tool.",
  oneShot: false  // recurring — fires every idle period
});
```

**Consolidation frequency limits:**
- Minimum interval: 30 minutes between runs
- Maximum interval: 6 hours (force if no idle period occurred)
- Skip if no new unconsolidated episodes exist

---

## 10. Session Bootstrap

### What Happens When a Session Starts (or Restarts After Crash)

```
start_session(threadId: 4821)
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  BOOTSTRAP SEQUENCE (~500ms, 0 LLM calls)            │
│                                                      │
│  1. Load meta-memory status                          │
│     → Memory health, time since last consolidation   │
│     → ~300 tokens                                    │
│                                                      │
│  2. Load operator profile from semantic memory       │
│     → Top preferences, name, communication style     │
│     → Query: type=preference, sort by access_count   │
│     → ~500 tokens                                    │
│                                                      │
│  3. Load recent context                              │
│     → Last 5 episodes for this thread                │
│     → Active procedures (last_executed in 7 days)    │
│     → ~1,500 tokens                                  │
│                                                      │
│  4. Load pending working buffer                      │
│     → Any unflushed observations from pre-crash      │
│     → ~200 tokens                                    │
│                                                      │
│  5. Assemble working memory                          │
│     → Total: ~2,500 tokens (well within 4K budget)   │
│     → Inject as first content block in tool response │
│                                                      │
│  6. Schedule consolidation task (if not exists)      │
│     → afterIdleMinutes: 30                           │
└──────────────────────────────────────────────────────┘
```

### Bootstrap Output Format

The bootstrap assembles a **session briefing** that becomes the first part of the `start_session` tool response:

```markdown
## Memory Briefing

**Operator:** Andrii
**Known preferences:** Voice interaction for casual updates • Text for technical details • Night owl (22:00-03:00) • Nova voice for TTS
**Recent mood:** Calm, focused (last 3 voice messages: arousal 0.20, valence 0.25)

**Last session context:** Designing multi-layer memory system for Sensorium MCP. Research comparison document reviewed. Five-layer architecture selected.

**Active procedures:**
- Deploy voice-analysis to Azure (confidence: 0.9, used 7×)
- Publish npm package (confidence: 0.85, used 4×)

**Memory health:** 142 episodes (23 unconsolidated) • 67 semantic notes • 8 procedures
**Last consolidation:** 4 hours ago • Next scheduled: after 30min idle

**Unflushed observations from previous session:**
- "Operator wants SQLite, not Neo4j"
- "Five-layer architecture: working, episodic, semantic, procedural, meta"
```

### Crash Recovery

Because all state is in SQLite:
1. Working buffer entries survive (flushed = 0 entries are re-loaded)
2. Episodes survive (already written at ingest time)
3. Semantic notes survive (on disk)
4. The bootstrap sequence is idempotent — safe to run multiple times

The only data lost in a crash is:
- In-progress consolidation (if it was running when the crash happened) — no problem, it re-runs next idle period
- The current LLM context window — rebuilt from bootstrap

---

## 11. MCP Tool Surface

### Tool Design Principles

1. **Minimal tool count.** Previous `atomic-memory-mcp` had 26 tools — too many. Target: **8 tools**.
2. **Budget-enforced returns.** Every read tool accepts `maxTokens` parameter.
3. **Composable.** Tools can be chained but each is self-sufficient.
4. **Agent-friendly descriptions.** Tool descriptions tell the agent *when* to use each tool.

### Tool Definitions

#### 1. `memory_bootstrap`

```yaml
name: memory_bootstrap
description: >
  Load memory briefing for session start. Call this ONCE at the beginning of 
  every session (after start_session). Returns operator profile, recent context, 
  active procedures, and memory health. Costs ~2,500 tokens.
input:
  threadId: number (required) — Active thread ID
output:
  Markdown-formatted session briefing (see Section 10)
```

#### 2. `memory_search`

```yaml
name: memory_search
description: >
  Search across all memory layers for information relevant to a query.
  Use this when you need to recall something — a fact, a preference, 
  a past event, or a procedure. Returns ranked results with source layer.
  
  WHEN TO USE: Before starting any task, search for relevant context.
  DO NOT USE: For information already in your working memory briefing.
input:
  query: string (required) — Natural language search query
  layers: string[] (optional) — Filter: ["episodic", "semantic", "procedural"]. Default: all.
  timeRange:
    from: string (optional) — ISO 8601 start
    to: string (optional) — ISO 8601 end
  types: string[] (optional) — Filter by memory type: ["fact", "preference", "pattern", "workflow", ...]
  modality: string (optional) — Filter: "voice", "text", "photo", "video_note"
  maxTokens: number (optional) — Token budget for results. Default: 1500.
output:
  Ranked list of memory entries with scores, layer source, and timestamps
```

#### 3. `memory_save`

```yaml
name: memory_save
description: >
  Explicitly save a piece of knowledge to semantic memory (Layer 3).
  Use this when you learn something important during conversation that 
  should persist. The system will automatically link it to related memories.
  
  WHEN TO USE: When the operator states a preference, corrects you, or 
  reveals a fact that will be useful in future sessions.
  DO NOT USE: For routine conversation — episodic memory captures that automatically.
input:
  content: string (required) — The fact/preference/pattern in one clear sentence
  type: string (required) — "fact" | "preference" | "pattern" | "entity" | "relationship"
  keywords: string[] (required) — 3-7 keywords for retrieval
  confidence: number (optional) — 0.0-1.0. Default: 0.8
  threadId: number (required)
output:
  Created note_id and auto-detected links
```

#### 4. `memory_save_procedure`

```yaml
name: memory_save_procedure
description: >
  Save or update a learned workflow/procedure to procedural memory (Layer 4).
  Use this when you've completed a task and realize the steps should be 
  remembered for next time, or when the operator teaches you a process.
  
  WHEN TO USE: After completing a multi-step task for the 2nd+ time.
  After the operator explicitly describes how they want something done.
input:
  name: string (required) — Short name for the procedure
  type: string (required) — "workflow" | "habit" | "tool_pattern" | "template"
  description: string (required) — What this procedure accomplishes
  steps: string[] (optional) — Ordered steps (for workflows)
  triggerConditions: string[] (optional) — When to use this procedure
  procedureId: string (optional) — Existing ID to update (omit to create new)
  threadId: number (required)
output:
  Created/updated procedure_id
```

#### 5. `memory_update`

```yaml
name: memory_update
description: >
  Update or supersede an existing semantic note or procedure.
  Use this when you discover that stored information is outdated or wrong.
  
  WHEN TO USE: When the operator corrects previously stored information.
  When you discover a fact has changed.
input:
  memoryId: string (required) — note_id or procedure_id to update
  action: string (required) — "update" (modify in place) | "supersede" (mark old as expired, create new)
  newContent: string (required for supersede, optional for update)
  newConfidence: number (optional)
  reason: string (required) — Why is this being updated?
  threadId: number (required)
output:
  Updated/new memory ID
```

#### 6. `memory_consolidate`

```yaml
name: memory_consolidate
description: >
  Run the memory consolidation cycle (sleep process). This is normally 
  triggered automatically during idle periods, but you can call it manually 
  if you notice memory is getting stale or after a large batch of work.
  
  WHEN TO USE: Automatically via scheduled task. Manually only if 
  memory_status shows many unconsolidated episodes.
input:
  threadId: number (required)
  phases: string[] (optional) — Run specific phases only: ["promote", "deduplicate", "extract_procedures", "decay", "meta", "multimodal"]. Default: all.
output:
  Consolidation report: episodes processed, notes created/merged/superseded, procedures updated
```

#### 7. `memory_status`

```yaml
name: memory_status
description: >
  Get memory system health and statistics. Lightweight (~300 tokens).
  
  WHEN TO USE: When unsure if you have relevant memories.
  To check if consolidation is needed. To report memory state to operator.
input:
  threadId: number (required)
output:
  Topic index, storage stats, last consolidation time, pending items count
```

#### 8. `memory_forget`

```yaml
name: memory_forget
description: >
  Explicitly mark a memory as expired/forgotten. Use sparingly — most 
  forgetting happens automatically through decay. This is for when the 
  operator explicitly asks you to forget something, or when information 
  is confirmed to be wrong.
input:
  memoryId: string (required) — note_id, procedure_id, or episode_id
  reason: string (required) — Why is this being forgotten?
  threadId: number (required)
output:
  Confirmation of what was forgotten
```

### Tool Count Comparison

| System | Tools | Notes |
|---|---|---|
| `atomic-memory-mcp` (previous) | 26 | Too many; agent confused about which to use |
| `@modelcontextprotocol/server-memory` | 6 | Baseline, limited |
| **Sensorium Memory** (this design) | **8** | Balanced — covers full lifecycle |

---

## 12. Storage Backend — Unified Schema

### File Location

```
~/.remote-copilot-mcp/
├── memory.db                  ← Main SQLite database (all layers)
├── files/                     ← Binary files (existing)
│   ├── voice_1710423055.ogg
│   ├── photo_1710423100.jpg
│   └── video_1710423200.mp4
├── threads/                   ← Dispatcher message files (existing)
├── schedules/                 ← Scheduler state (existing)
├── poller.lock                ← Dispatcher lock (existing)
└── offset                     ← Dispatcher offset (existing)
```

### SQLite Pragmas

```sql
-- Performance + durability settings
PRAGMA journal_mode = WAL;           -- Allow concurrent reads during writes
PRAGMA synchronous = NORMAL;         -- Good durability without full fsync
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;          -- Wait 5s on locks instead of failing
PRAGMA cache_size = -8000;           -- 8MB cache
```

### Full Schema (All Tables)

```sql
-- ==========================================================
-- Layer 1: Working Memory Buffer
-- ==========================================================

CREATE TABLE working_buffer (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  thread_id   INTEGER NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  flushed     INTEGER DEFAULT 0
);

-- ==========================================================
-- Layer 2: Episodic Memory
-- ==========================================================

CREATE TABLE episodes (
  episode_id     TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  thread_id      INTEGER NOT NULL,
  timestamp      TEXT NOT NULL,
  type           TEXT NOT NULL CHECK(type IN ('operator_message','agent_action','system_event')),
  modality       TEXT NOT NULL CHECK(modality IN ('text','voice','photo','video_note','document','mixed')),
  content        TEXT NOT NULL,                -- JSON
  topic_tags     TEXT,                         -- JSON array
  importance     REAL NOT NULL DEFAULT 0.5,
  consolidated   INTEGER DEFAULT 0,
  accessed_count INTEGER DEFAULT 0,
  last_accessed  TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_ep_thread_time ON episodes(thread_id, timestamp DESC);
CREATE INDEX idx_ep_importance ON episodes(importance DESC);
CREATE INDEX idx_ep_uncons ON episodes(consolidated) WHERE consolidated = 0;

CREATE VIRTUAL TABLE episodes_fts USING fts5(
  episode_id, text_content, topic_tags,
  content='episodes', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- ==========================================================
-- Layer 3: Semantic Memory
-- ==========================================================

CREATE TABLE semantic_notes (
  note_id         TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK(type IN ('fact','preference','pattern','entity','relationship')),
  content         TEXT NOT NULL,
  keywords        TEXT NOT NULL,               -- JSON array
  confidence      REAL NOT NULL DEFAULT 0.5,
  source_episodes TEXT,                        -- JSON array
  linked_notes    TEXT,                        -- JSON array
  link_reasons    TEXT,                        -- JSON object
  valid_from      TEXT NOT NULL,
  valid_to        TEXT,
  superseded_by   TEXT,
  access_count    INTEGER DEFAULT 0,
  last_accessed   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_sem_type ON semantic_notes(type);
CREATE INDEX idx_sem_conf ON semantic_notes(confidence DESC);
CREATE INDEX idx_sem_valid ON semantic_notes(valid_to) WHERE valid_to IS NULL;

CREATE VIRTUAL TABLE semantic_fts USING fts5(
  note_id, content, keywords,
  content='semantic_notes', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- ==========================================================
-- Layer 4: Procedural Memory
-- ==========================================================

CREATE TABLE procedures (
  procedure_id       TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL CHECK(type IN ('workflow','habit','tool_pattern','template')),
  description        TEXT NOT NULL,
  steps              TEXT,                     -- JSON array
  trigger_conditions TEXT,                     -- JSON array
  success_rate       REAL DEFAULT 0.5,
  times_executed     INTEGER DEFAULT 0,
  last_executed_at   TEXT,
  learned_from       TEXT,                     -- JSON array
  corrections        TEXT,                     -- JSON array
  related_procedures TEXT,                     -- JSON array
  confidence         REAL DEFAULT 0.5,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE VIRTUAL TABLE procedures_fts USING fts5(
  procedure_id, name, description, trigger_conditions,
  content='procedures', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- ==========================================================
-- Layer 5: Meta-Memory
-- ==========================================================

CREATE TABLE meta_topic_index (
  topic            TEXT PRIMARY KEY,
  semantic_count   INTEGER DEFAULT 0,
  procedural_count INTEGER DEFAULT 0,
  last_updated     TEXT,
  avg_confidence   REAL DEFAULT 0.5,
  total_accesses   INTEGER DEFAULT 0
);

CREATE TABLE meta_retrieval_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp      TEXT NOT NULL,
  query_text     TEXT,
  layer          TEXT,
  results_count  INTEGER,
  tokens_used    INTEGER,
  was_useful     INTEGER DEFAULT 1
);

CREATE TABLE meta_consolidation_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at              TEXT NOT NULL,
  episodes_processed  INTEGER,
  notes_created       INTEGER,
  notes_merged        INTEGER,
  notes_superseded    INTEGER,
  procedures_updated  INTEGER,
  duration_ms         INTEGER
);

CREATE TABLE meta_confidence (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL,
  note_id    TEXT,
  confidence REAL,
  was_correct INTEGER
);

-- ==========================================================
-- Multimodal: Voice Signatures
-- ==========================================================

CREATE TABLE voice_signatures (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id     TEXT NOT NULL,
  emotion        TEXT,
  arousal        REAL,
  dominance      REAL,
  valence        REAL,
  speech_rate    REAL,
  mean_pitch_hz  REAL,
  pitch_std_hz   REAL,
  jitter         REAL,
  shimmer        REAL,
  hnr_db         REAL,
  audio_events   TEXT,                    -- JSON array
  duration_sec   REAL,
  file_path      TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_voice_ep ON voice_signatures(episode_id);
CREATE INDEX idx_voice_time ON voice_signatures(created_at DESC);

-- ==========================================================
-- Schema version tracking
-- ==========================================================

CREATE TABLE schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

INSERT INTO schema_version (version, applied_at) VALUES (1, datetime('now'));
```

### Estimated Storage Growth

| Duration | Episodes | Semantic notes | Procedures | Voice sigs | DB size |
|---|---|---|---|---|---|
| 1 week | ~200 | ~50 | ~5 | ~30 | ~2 MB |
| 1 month | ~800 | ~150 | ~15 | ~100 | ~8 MB |
| 6 months | ~4,000 | ~500 | ~40 | ~500 | ~40 MB |
| 1 year | ~7,000 | ~800 | ~60 | ~900 | ~70 MB |

After archival: episodes older than 30 days (consolidated, low importance) are moved to a compressed archive table, keeping the active DB ~15 MB after 1 year.

---

## 13. Lifecycle of a Memory

### Complete Flow: Operator Says "I prefer dark themes"

```
T+0s    Operator sends text message: "I prefer dark themes"
        │
        ▼
T+0.1s  INGEST (automatic)
        → Episode created: ep_20260314_150000_x1y2
          type: operator_message, modality: text
          content: {"text": "I prefer dark themes"}
          topic_tags: ["preference", "theme", "UI"]
          importance: 0.7 (preference indicator detected)
        │
        ▼
T+0.5s  AGENT receives message, processes it
        → Agent calls memory_search("dark theme preference")
        → Returns: no existing notes about themes
        → Agent calls memory_save:
          content: "Operator prefers dark themes for UI/editor"
          type: "preference"
          keywords: ["dark theme", "UI", "editor", "preference"]
          confidence: 0.9
        → Semantic note created: sem_theme_dark_001
          linked automatically to: sem_editor_prefs (existing note about editor settings)
        │
        ▼
T+30min CONSOLIDATION (sleep cycle fires)
        → Phase 1: Episode ep_20260314_150000_x1y2 already has
          corresponding semantic note → mark consolidated = true
        → Phase 2: Check for duplicates — no similar notes found
        → Phase 5: Update meta topic_index:
          "operator-preferences" count +1
        │
        ▼
T+7d    NEXT SESSION BOOTSTRAP
        → sem_theme_dark_001 ranked high (preference type, high confidence, recent)
        → Included in working memory briefing:
          "Known preferences: ... dark themes for UI ..."
        │
        ▼
T+60d   DECAY CHECK
        → sem_theme_dark_001 accessed 3× in sessions → confidence maintained
        → Still in valid state (valid_to = NULL)
        │
        ▼
T+180d  Operator says "actually I switched to light theme"
        → Agent calls memory_update:
          memoryId: sem_theme_dark_001
          action: "supersede"
          newContent: "Operator now prefers light themes"
          reason: "Operator explicitly stated preference change"
        → Old note: valid_to = now, superseded_by = sem_theme_light_001
        → New note: sem_theme_light_001, valid_from = now
        → History preserved — can still query "what did the operator prefer before?"
```

---

## 14. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| **Session crash mid-conversation** | Lose in-context working memory | Working buffer persisted to SQLite every write; bootstrap rebuilds from persistent layers |
| **SQLite corruption** | Lose all memory | WAL mode + NORMAL sync. Periodic backup to `memory.db.bak` (daily). Schema migration on startup validates tables exist. |
| **LLM extraction hallucinates** | Wrong facts in semantic memory | Confidence scoring + source_episodes audit trail. Operator corrections tracked. Meta-memory calibration detects systematic drift. |
| **Consolidation runs too long** | Blocks agent during idle | Phase timeout: each phase capped at 10s. Total consolidation capped at 60s. Incomplete phases resume next cycle. |
| **Memory grows unbounded** | Slow queries, large DB | Archive policy (30-day episodes), decay functions, meta-memory tracks sizes. Alert at 100MB. |
| **Context overflow from memory retrieval** | Agent crashes | Token budgets enforced at tool level. `maxTokens` parameter on every read tool. Working memory hard cap at 4K. |
| **Agent forgets to search memory** | "Amnesia" — doesn't use stored knowledge | Bootstrap briefing passive-loads critical memories. Tool descriptions remind agent when to search. |
| **Conflicting memories** | Agent gives contradictory answers | HiMem-style conflict resolution during consolidation. `superseded_by` chain preserves history. Agent sees latest valid note. |
| **Concurrent MCP sessions** | Multiple processes write to same DB | SQLite WAL mode handles concurrent reads. Writes are serialized by SQLite's built-in locking. Thread ID scoping prevents cross-session interference. |
| **Voice analysis service down** | Missing emotion data | Graceful degradation (already implemented in `openai.ts`). Voice signatures store NULL for unavailable fields. Patterns computed from available data only. |

---

## 15. Migration Path from Existing Systems

### From `atomic-memory-mcp` (Knowledge Graph → Sensorium Memory)

```
atomic-memory-mcp entities → semantic_notes (type: entity)
atomic-memory-mcp observations → semantic_notes (type: fact)
atomic-memory-mcp relations → semantic_notes (type: relationship)
atomic-memory-mcp thread files → episodes (backfill from JSONL)
```

Migration script reads existing JSONL files from `~/.atomic-memory-mcp/`, transforms entities into semantic notes, and bulk-inserts into SQLite.

### From `mcp-memory-graph-enhanced` (Neo4j/JSONL → Sensorium Memory)

Same approach — JSONL files are the portable format. Neo4j edges become `linked_notes` references.

### Coexistence Period

During migration, both memory systems can run simultaneously. The new system reads from SQLite; the old system's JSONL files are read-only (import-once). After validation, the old MCP server is removed from the configuration.

---

## 16. Open Questions

### Must Decide Before Implementation

1. **Embedding model for semantic search?** Current design uses FTS5 (keyword-based). Adding vector embeddings (via `better-sqlite3-vec` or ONNX runtime) would enable proper semantic similarity but adds complexity. **Recommendation:** Start with FTS5 only. Add embeddings in v2 if keyword search proves insufficient. Most MCP memory servers that use local embeddings report good results with ONNX (all-MiniLM-L6-v2).

2. **Who runs consolidation LLM calls?** The memory MCP server can't call an LLM by itself — it's a tool server, not an agent. **Options:**
   - **(a)** The agent runs consolidation by calling `memory_consolidate`, which returns prompts the agent processes and feeds back. Downside: requires the agent to be active.
   - **(b)** The memory server calls OpenAI directly (using `OPENAI_API_KEY` already available in the environment). Upside: truly autonomous. Downside: cost without agent awareness.
   - **(c)** Consolidation is a scheduled task prompt that wakes the agent (via existing `schedule_wake_up`), and the agent calls `memory_consolidate` which returns structured instructions. **Recommended — leverages existing infrastructure.**

3. **Importance scoring model?** Current design uses LLM-assigned importance (0.0-1.0) at ingest time. This adds latency to every message. **Alternative:** Rule-based heuristics (questions = 0.7, corrections = 0.9, greetings = 0.2, contains "important"/"remember" = 0.8). **Recommendation:** Start with heuristics, calibrate with LLM during consolidation.

4. **Cross-thread memory access?** Should semantic notes be global (shared across all Telegram threads) or scoped per thread? **Recommendation:** Semantic notes and procedures are GLOBAL (knowledge transcends sessions). Episodes are SCOPED to thread (events are session-specific). Working buffer is scoped to session.

### Future Enhancements (v2+)

- **Vector embeddings** via `better-sqlite3-vec` extension for true semantic similarity search
- **Memory visualization** — generate a knowledge graph diagram on demand (Mermaid/D3)
- **Multi-user support** — per-operator memory partitions (if multiple operators use the same bot)
- **Memory export/import** — portable format for backup, sharing, or transfer between agents
- **Proactive memory** — agent preemptively loads relevant memories based on conversation topic detection (not just explicit search)
- **Memory Debate** — when confidence is low, present competing memories to the operator and ask them to resolve

---

## Appendix A: Token Budget Summary

| Component | Budget | Notes |
|---|---|---|
| Working memory briefing | 4,000 | Hard cap, assembled by bootstrap |
| `memory_search` results | 1,500 | Default, configurable via `maxTokens` |
| `memory_status` | 300 | Fixed, lightweight |
| Consolidation (per phase) | 2,500 | LLM input+output per phase |
| Total consolidation (6 phases) | ~10,000 | Spread over 30+ seconds |
| Episodic ingest (per message) | 0 | No LLM call — heuristic importance |

**Comparison with previous systems:**
- `atomic-memory-mcp` full dump: 15,000-50,000+ tokens (unbounded)
- Sensorium bootstrap: 2,500 tokens (fixed)
- Sensorium per-search: 1,500 tokens (capped)

**Token reduction: ~85-95%** (consistent with A-Mem's findings)

## Appendix B: MCP Server Configuration

```jsonc
// In mcp.json (VS Code) or claude_desktop_config.json
{
  "servers": {
    "sensorium-memory": {
      "command": "node",
      "args": ["path/to/sensorium-memory-mcp/dist/index.js"],
      "env": {
        "MEMORY_DB_PATH": "~/.remote-copilot-mcp/memory.db",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}",     // For consolidation LLM calls
        "MAX_WORKING_MEMORY_TOKENS": "4000",
        "MAX_SEARCH_TOKENS": "1500",
        "CONSOLIDATION_IDLE_MINUTES": "30",
        "EPISODE_ARCHIVE_DAYS": "30",
        "SEMANTIC_DECAY_HALFLIFE_DAYS": "14"
      }
    }
  }
}
```

## Appendix C: Comparison with Previous Attempts

| Dimension | `atomic-memory-mcp` | `mcp-memory-graph-enhanced` | **Sensorium Memory** |
|---|---|---|---|
| Storage | JSONL files | JSONL + Neo4j | SQLite (single file) |
| Memory layers | 1 (flat graph) | 1 (flat graph) | 5 (hierarchical) |
| Token management | None (dumps all) | None | Budget-enforced at every tool |
| Temporal reasoning | Timestamps only | Timestamps only | `valid_from`/`valid_to` + decay |
| Self-improvement | None | None | Sleep cycle consolidation |
| Voice/multimodal | None | None | First-class voice signatures + patterns |
| Crash survival | Partial (JSONL) | Partial | Full (SQLite WAL + working buffer) |
| Conflict resolution | Flags conflicts | None | Auto-supersede with history |
| Infrastructure | None / Neo4j | Neo4j optional | SQLite only (zero dependencies) |
| Tools | 26 | ~10 | 8 |

---

*End of design document. Implementation plan to follow as a separate phase.*
