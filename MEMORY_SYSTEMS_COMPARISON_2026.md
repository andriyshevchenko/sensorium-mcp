# LLM Agent Memory Systems — State of the Art (Early 2026)

> Comprehensive comparison of architectures, implementations, and research frontiers.

---

## Table of Contents

1. [Simple Event Log / Conversation History](#1-simple-event-log--conversation-history)
2. [Graph Memory with Atomic Facts](#2-graph-memory-with-atomic-facts)
3. [Multi-Layer / Hierarchical Memory](#3-multi-layer--hierarchical-memory)
4. [Self-Improving / Self-Organizing Memory](#4-self-improving--self-organizing-memory)
5. [andriyshevchenko's Memory Projects](#5-andriyshevchenkos-memory-projects)
6. [Cross-Architecture Comparison Table](#6-cross-architecture-comparison-table)
7. [MCP Memory Server Ecosystem](#7-mcp-memory-server-ecosystem)
8. [Key Research Papers](#8-key-research-papers)
9. [Verdict & Recommendations](#9-verdict--recommendations)

---

## 1. Simple Event Log / Conversation History

### How It Works

The most primitive approach: store the raw conversation as an ordered list of `(role, content)` tuples and replay them into the context window on each turn.

**Variants:**
| Variant | Mechanism |
|---|---|
| **Full buffer** | Entire history dumped into prompt |
| **Sliding window** | Last _N_ messages kept, older ones dropped |
| **Summary buffer** | LLM periodically summarizes older history into a compressed paragraph |
| **Token-limited buffer** | Trim from the front when token count exceeds threshold |

### Storage Format & Backend

- **Format:** JSON arrays, plain text logs, message objects
- **Backend:** In-memory (ephemeral), SQLite, Redis, flat files
- **Example:** LangChain's `ConversationBufferMemory`, `ConversationSummaryMemory`

### Retrieval Strategy

- **None** — everything is in the prompt already (full buffer)
- **Recency-biased** — sliding window drops old messages
- **Summary retrieval** — compressed summaries injected as system messages

### Memory Growth / Pruning

- **Full buffer:** Grows unbounded → hits context window limit → catastrophic failure
- **Sliding window:** Hard cutoff; old information permanently lost
- **Summary buffer:** Lossy compression; nuances, names, dates get lost in summarization

### Real-World Failure Modes

| Failure | Impact |
|---|---|
| **Context overflow** | Once history exceeds context window, system either crashes or silently drops information |
| **Lost-in-the-middle** | LLMs attend poorly to information in the middle of long contexts (Liu et al., 2023). Even within the window, recall degrades 33%+ for multi-turn information tracking (Laban, 2026) |
| **Summary hallucination** | LLM-generated summaries introduce fabricated details or drop critical facts |
| **No cross-session persistence** | By default, history resets per session; requires explicit serialization |
| **Cost explosion** | Sending 100K+ tokens every turn gets expensive fast |

### Session Persistence / Running Indefinitely

❌ Not natively. Requires external persistence layer (database, file). Even then, you can't replay infinite history into a finite context window.

### Verdict

Good for demos and short conversations. Breaks hard past ~50-100 turns or when information must persist across sessions. The "context rot" problem (Anthropic, 2026) means performance degrades long before you hit the hard token limit.

---

## 2. Graph Memory with Atomic Facts

### Overview

The dominant paradigm in 2025-2026. Instead of storing raw conversations, extract **atomic facts** (entity-relation-entity triples or discrete observations) and store them in a structured knowledge graph or vector store.

### Major Implementations

#### 2a. Mem0

- **Architecture:** Three-tier storage
  1. **Vector DB** (Qdrant, Pinecone, Chroma, FAISS) — semantic similarity search on extracted memories
  2. **Graph DB** (optional, Neo4j) — entity-relationship tracking
  3. **SQLite** — full audit trail of all memory operations
- **How extraction works:** An "extraction LLM" parses each conversation turn, identifies entities/relationships/timestamps, and makes CRUD decisions (ADD / UPDATE / DELETE / NONE) on memories
- **Key insight:** LLM-as-Memory-Manager — the LLM itself decides what to remember, update, or forget
- **Retrieval:** Hybrid — vector similarity narrows candidates, then graph traversal returns related context
- **Pruning:** LLM-driven deduplication and contradiction resolution. Memories can be updated or deleted when new info conflicts with old info
- **Format:** Memories stored as natural language strings + embeddings + optional graph triples
- **Benchmark (Mem0 blog, April 2025):**
  
  | System | Judge Accuracy | p95 Latency | Tokens/query |
  |---|---|---|---|
  | **Mem0** | 66.9% | 1.4s | ~2K |
  | **Mem0 + Graph** | 68.5% | 2.6s | ~4K |
  | OpenAI Memory | 52.9% | 0.9s | ~5K |
  | LangMem | 58.1% | 60s | ~130 |

- **Failure modes:**
  - Extraction LLM can miss subtle facts or hallucinate relationships
  - Graph becomes stale if update logic is poorly tuned
  - Cloud dependency for managed version; self-hosted requires Docker + Qdrant + OpenAI key
  - No temporal reasoning in base vector mode (graph mode helps)

#### 2b. Zep / Graphiti

- **Architecture:** Temporal knowledge graph with three hierarchical subgraphs:
  1. **Episode subgraph** — raw conversation episodes with timestamps
  2. **Semantic entity subgraph** — extracted entities and relationships (time-stamped edges)
  3. **Community subgraph** — automatically detected clusters/communities of related entities
- **How it works:** Graphiti ingests unstructured/structured data → LLM extracts entities and relations → schema-consistent graph maintained (reuses existing node/edge types) → edges carry temporal metadata (valid_from, valid_to, created_at)
- **Retrieval:** Hybrid search — temporal queries + full-text search + semantic similarity + graph traversal algorithms. Results typically < 100ms
- **Key differentiator:** **Temporal reasoning** — can answer "what did the user prefer *before* they changed their mind?" and track entity evolution over time
- **Pruning:** Edge invalidation rather than deletion — old relationships get `valid_to` timestamps, preserving history
- **Storage backend:** Neo4j (graph), with embedding storage for semantic search
- **Benchmark:** Outperforms MemGPT on Deep Memory Retrieval (DMR) benchmark. Significant improvements on LongMemEval
- **Failure modes:**
  - Neo4j dependency (heavy infrastructure)
  - Entity resolution is imperfect — same entity can create duplicate nodes
  - Community detection quality depends on graph density
  - Zep cloud-only; Graphiti is OSS but requires self-hosting Neo4j

#### 2c. MemGPT / Letta

- **Architecture:** Virtual context management (OS-inspired memory hierarchy)
  - **Main context** (working memory) — what's currently in the LLM prompt. Divided into:
    - System instructions
    - Core memory (user info, persona) — agent can self-edit
    - Recall memory buffer — recent conversation
  - **Archival memory** (long-term) — unlimited external storage, searched on demand
  - **Recall storage** — full conversation history, searchable
- **Key insight:** The **LLM itself is the memory manager**. It decides when to:
  - Page information in/out of context (like OS virtual memory paging)
  - Edit its own core memory blocks
  - Search archival storage for relevant facts
  - Archive information from context to long-term storage
- **Retrieval:** Agent-initiated — the LLM calls memory tools (`archival_memory_search`, `core_memory_replace`, etc.) as function calls
- **Storage backend:** PostgreSQL (via Supabase or local), with vector embeddings for archival search
- **Pruning:** Agent-driven — LLM decides what to keep in context vs. archive
- **Session persistence:** ✅ Yes — state persists across sessions natively. This is the core design goal
- **Failure modes:**
  - Agent may fail to search archival memory when it should ("forgetting to remember")
  - Core memory edits can be destructive if the LLM makes bad decisions
  - High latency — multiple LLM calls per turn for memory management
  - Complex multi-step conversations can overwhelm the paging mechanism

#### 2d. A-Mem (Zettelkasten Method) — NeurIPS 2025

- **Architecture:** Self-organizing knowledge network inspired by the Zettelkasten note-taking method
- **How it works:** Each memory is stored as a structured "note" containing:
  - Contextual description
  - Keywords and tags
  - Links to related notes (dynamic bidirectional indexing)
  - Importance score
- **Key differentiator:** **Agentic memory management** — the memory system itself uses an LLM agent to decide how to organize, link, and restructure memories dynamically. No fixed operations or predetermined structure
- **Retrieval:** Graph traversal through linked notes + semantic search
- **Results:** 85-93% token reduction vs. full context approaches while maintaining or improving accuracy
- **Storage:** Graph-like note network with embeddings
- **Failure modes:**
  - LLM-driven organization is non-deterministic
  - Link quality depends on extraction quality
  - Computational overhead for reorganization

---

## 3. Multi-Layer / Hierarchical Memory

### Research Papers

#### 3a. HiMem (January 2026) — Macau University of Science and Technology

**Paper:** "HiMem: Hierarchical Long-Term Memory for LLM Long-Horizon Agents" (arXiv:2601.06377)

- **Two-layer architecture:**
  1. **Episode Memory** — constructed via "Topic-Aware Event–Surprise Dual-Channel Segmentation"
     - Segments conversations into coherent episodes based on topic shifts AND surprising/unexpected events
     - Preserves temporal ordering and event boundaries
  2. **Note Memory** — stable knowledge extracted through multi-stage information extraction pipeline
     - Captures generalized facts, preferences, and patterns
     - Semantically linked to episode memory for bidirectional navigation
- **Retrieval:** Hybrid + best-effort strategies balancing accuracy and efficiency
- **Self-evolution:** **Conflict-aware Memory Reconsolidation** — when retrieval reveals conflicts between stored knowledge and new input, the system revises and supplements stored knowledge
- **Results:** Outperforms baselines on long-horizon dialogue benchmarks in accuracy, consistency, and long-term reasoning
- **Code:** https://github.com/jojopdq/HiMem

#### 3b. G-Memory (NeurIPS 2025) — Multi-Agent Hierarchical Memory

**Paper:** "G-Memory: Tracing Hierarchical Memory for Multi-Agent Systems" (arXiv:2506.07398)

- **Focus:** Memory for multi-agent systems (MAS), not just single agents
- **Presented at NeurIPS 2025** (Spotlight Poster)
- Addresses how multiple agents can share, trace, and manage hierarchical memory structures
- Enables self-evolution of agent capabilities through shared memory

#### 3c. HiAgent (2024) — Hierarchical Working Memory

**Paper:** "HiAgent: Hierarchical Working Memory Management for Solving Long-Horizon Agent Tasks" (arXiv:2408.09559)

- Inspired by human problem-solving strategies
- Hierarchical working memory for long-horizon tasks (not just dialogue)
- Published at AAAI/similar venue

#### 3d. Pancake (February 2026) — Hierarchical Memory for Multi-Agent Serving

**Paper:** "Pancake: Hierarchical Memory System for Multi-Agent LLM Serving" (arXiv:2602.21477)

- Addresses memory management challenges specific to **serving infrastructure** for multi-agent systems
- Focus on efficiency and scalability at deployment time

#### 3e. Practical 7-Layer Architecture (Jeremiah Ojo, February 2026)

An engineer built a 7-layer memory architecture for multi-agent systems:
- Persistent, searchable, self-linking memory across sessions
- Zero additional infrastructure cost
- Each agent gets its own memory partition with cross-agent linking
- Uses open-source tools only

#### 3f. Hindsight (December 2025) — Retain, Recall, Reflect

**Paper:** "Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects" (arXiv:2512.12818)

- Critiques current generation of memory systems for blurring evidence vs. inference
- Proposes structured separation between raw evidence, extracted knowledge, and agent reasoning
- Addresses explainability in memory-augmented agents

### How Hierarchical Memory Works (General Pattern)

```
┌─────────────────────────────────────────┐
│           WORKING MEMORY                │  ← In-context, small, fast
│  (current task, recent turns)           │
├─────────────────────────────────────────┤
│         EPISODIC MEMORY                 │  ← Time-stamped events
│  (what happened, when, with whom)       │
├─────────────────────────────────────────┤
│         SEMANTIC MEMORY                 │  ← Extracted facts/knowledge
│  (preferences, entities, relationships) │
├─────────────────────────────────────────┤
│        PROCEDURAL MEMORY                │  ← Skills, workflows
│  (how to do things, learned patterns)   │
└─────────────────────────────────────────┘
```

**Key insight from Zylos Research (Jan 2026):** Store *understanding* (knowledge networks) rather than mechanical action sequences. The distinction between **memory** (personal, dynamic, per-user) and **knowledge** (facts true for all users, stable) is critical.

---

## 4. Self-Improving / Self-Organizing Memory

### 4a. Sleep-Based Learning / Memory Consolidation

The most biologically-inspired frontier. Multiple independent groups converged on this idea in 2025-2026.

#### "Language Models Need Sleep" (ICLR 2026, Under Review)

- **Paper:** OpenReview submission for ICLR 2026
- **Concept:** A "Sleep" paradigm for LLMs with two stages:
  1. **Memory Consolidation** — parameter expansion to absorb short-term in-context knowledge into long-term weights
  2. **Dreaming** — self-modification process that reorganizes learned representations
- Transfers short-term fragile memories into stable long-term knowledge
- Inspired by human learning processes

#### Sleeping LLM (vbario, February 2026)

- **Repo:** https://github.com/vbario/sleeping-llm
- **Architecture:** Wake/Sleep cycle for local LLMs
  - **Wake:** Facts extracted from conversation → injected into MLP weights via **MEMIT** (Mass-Editing Memory in Transformers). Single forward pass, instant recall. No database, no RAG
  - **Sleep:** System audits every stored fact, refreshes degraded memories with null-space constraints, then **LoRA consolidation** progressively transfers knowledge from MEMIT → fused LoRA (like hippocampus → neocortex transfer)
- **Key findings:**
  - Hard **capacity ceiling**: 8B model sustains 0.92 recall up to 13 facts, then crashes to 0.57 at fact 14 (phase transition, not gradual)
  - LoRA consolidation blocked by **"alignment tax"**: RLHF training fights against injected knowledge (37% recall loss per LoRA pass)
  - **Fix:** Per-fact graduated consolidation with dissolution schedule (MEMIT weight 1.0 → 0.5 → 0.1 → 0.0 as LoRA absorbs each fact)
  - Cumulative fusing reduces alignment tax from catastrophic to negligible
- **Hardware results:**

  | Hardware | Model | Facts | Recall |
  |---|---|---|---|
  | MacBook Air M3 8GB | Llama-3.2-3B-4bit | ~15 | Works, sleep ~5 min |
  | 2×H100 80GB | Llama-3.1-8B | 30 | 100% after sleep |
  | 2×H100 80GB | Llama-3.1-70B | 60 | 100%, 0% PPL impact |

#### LLM Sleep-Based Learning (Gal Lahat, November 2025)

- Implements REM-style cycles + synthetic dreaming
- **Wake:** Agent accumulates structured episodic memories
- **Sleep:** Model "dreams" (generates synthetic predictions from recent interactions) and trains on mixture of dreams + past memories + grounding data
- Consolidates user-specific information into model weights permanently
- Addresses catastrophic forgetting via interleaved replay

#### Dream Pruning (March 2026)

- **Concept:** "What happens when AI models sleep"
- Uses SVD decomposition to reorganize learned representations during "sleep"
- Keeps structure, discards noise
- Biologically-inspired consolidation producing balanced intelligence

#### "Let Them Sleep" (McCrae Tech, December 2025)

- **Paper/Blog:** Proposes sleep cycle for LLM-based agents
- **Day:** Agent accumulates structured episodic memories from interactions
- **Sleep:** Background pipeline curates memories → parameter-efficient fine-tuning (LoRA)
- Adapts LLM weights to incorporate accumulated experience

#### Entelgia (Reddit, March 2026)

- Multi-agent cognitive architecture with sleep/dream cycles
- Each agent has energy (loses 30% per turn)
- When energy drops low → enters sleep cycle
- Running locally on Ollama (8GB RAM, Qwen 7B)
- Built by someone with a psychology degree, coded with GPT

### 4b. Self-Organizing / Self-Restructuring

#### A-Mem (NeurIPS 2025)

Already described above — memories self-organize through dynamic Zettelkasten-style linking. The memory system autonomously creates, links, and restructures notes without human intervention.

#### HiMem's Conflict-Aware Reconsolidation

During retrieval, if conflicts are detected between stored knowledge and current context, the system actively revises and supplements stored memories. This is a form of "self-healing" memory.

#### Auto-Consolidation in MCP Servers

The Reddit user `_rendro` built an MCP memory server with:
- Memory decay with 30-day half-life
- Property graph for linking related memories
- **Auto-consolidation** that merges similar or related memories when they accumulate

### Summary: Can Any System Restructure During Idle Time?

| System | Idle-Time Restructuring | Mechanism |
|---|---|---|
| Sleeping LLM | ✅ Yes | MEMIT → LoRA consolidation during `/sleep` |
| "Language Models Need Sleep" | ✅ Yes | Memory consolidation + dreaming |
| LLM Sleep-Based Learning | ✅ Yes | REM-style cycles + synthetic dreaming |
| Dream Pruning | ✅ Yes | SVD reorganization |
| Entelgia | ✅ Yes | Energy-based sleep cycles |
| A-Mem | ⚠️ Partially | Self-organization on write, not idle |
| HiMem | ⚠️ Partially | Reconsolidation on retrieval, not idle |
| Mem0/Zep/MemGPT | ❌ No | Passive storage; no background processing |

---

## 5. andriyshevchenko's Memory Projects

Found two MCP memory server projects by GitHub user **andriyshevchenko**:

### 5a. `atomic-memory-mcp` (v3.1.0)

- **URL:** https://github.com/andriyshevchenko/atomic-memory-mcp
- **Listed on LobeHub** with PREMIUM rating (26 score)
- **26 MCP tools** — full-featured memory management
- **Capabilities:**
  - Knowledge graph-based persistent memory
  - Save/create/update/delete entities and relations
  - Advanced graph querying with pathfinding between entities
  - **Thread isolation** — per-conversation memory threads
  - **Conflict detection** — identifies contradictory observations
  - **Importance scoring** — prune low-importance or outdated entities
  - Bulk operations and review
  - Data validation and statistics
- **Stack:** TypeScript, MIT License
- **Published:** February 2026

### 5b. `mcp-memory-graph-enhanced` (v2.2.1)

- **URL:** https://github.com/andriyshevchenko/mcp-memory-graph-enhanced
- **Description:** Enhanced version of the Anthropic Memory MCP server
- **Enhancements over base `@modelcontextprotocol/server-memory`:**
  - Agent thread isolation (separate JSONL files per thread)
  - Timestamps on all operations
  - Confidence scoring for observations
  - **Neo4j** optional storage backend (in addition to JSONL)
  - Performance optimized: set-based lookups O(1), BFS algorithms for pathfinding
  - Security hardened: no sensitive data in logs, typed error handling
  - Robust error handling: malformed JSON, orphaned relations, empty files
- **Stack:** TypeScript, MIT License
- **Published:** January 2026

### Note on "a2make" / "automake"

No repos named "a2make" or "automake" were found under andriyshevchenko. The closest match in the broader ecosystem is **A2M (Agent2Memory) Protocol** by `dibenedetto` — a shared memory protocol for cross-framework agent communication (LangChain, Agno, n8n, CrewAI, AutoGen). This is unrelated to andriyshevchenko.

---

## 6. Cross-Architecture Comparison Table

| Dimension | Event Log | Graph/Atomic Facts (Mem0, Zep) | Hierarchical (HiMem) | Self-Organizing (A-Mem) | Sleep-Based (Sleeping LLM) |
|---|---|---|---|---|---|
| **Storage format** | Raw messages (JSON) | Triples + embeddings + graph edges | Episode nodes + Note nodes + links | Zettelkasten notes with dynamic links | Model weights (MEMIT edits + LoRA) |
| **Storage backend** | In-memory / SQLite / Redis | Vector DB + Graph DB (Neo4j) + SQLite | Custom stores + embeddings | Graph + embeddings | Model parameters themselves |
| **Retrieval** | Recency / full dump | Hybrid: vector similarity + graph traversal + temporal | Hybrid + best-effort; episode→note navigation | Graph traversal + semantic search | Direct weight access (zero retrieval latency) |
| **Memory growth** | Unbounded → overflow | LLM-managed CRUD; graph grows | Reconsolidation revises stored knowledge | Self-linking, self-restructuring | Hard capacity ceiling (phase transition) |
| **Pruning** | Truncation / summarization | Contradiction detection, dedup, temporal invalidation | Conflict-aware reconsolidation | Importance-based, dynamic | Sleep-based: audit + refresh + dissolve |
| **Cross-session** | ❌ Without external DB | ✅ Native | ✅ Native | ✅ Native | ✅ In weights permanently |
| **Run indefinitely** | ❌ Context overflow | ✅ With caveats (graph bloat) | ✅ Designed for it | ✅ With reorganization | ⚠️ Limited by weight capacity |
| **Latency per query** | ~0 (in-context) | 1-3s (Mem0); <100ms (Graphiti) | Variable | Variable | ~0 (in weights) |
| **Infrastructure** | Minimal | Heavy (vector DB + graph DB + LLM) | Moderate | Moderate | Heavy (GPU for MEMIT) |
| **Maturity** | Production-ready | Production-ready (Mem0, Zep) | Research stage | NeurIPS 2025 paper | Experimental |

---

## 7. MCP Memory Server Ecosystem

The Model Context Protocol (MCP) has spawned a rich ecosystem of memory servers as of early 2026:

| Server | Architecture | Storage | Key Feature |
|---|---|---|---|
| **@modelcontextprotocol/server-memory** (official) | Knowledge graph | JSONL files | Baseline — entities, relations, observations |
| **andriyshevchenko/atomic-memory-mcp** | Enhanced knowledge graph | JSONL + optional Neo4j | 26 tools, thread isolation, conflict detection, importance scoring |
| **andriyshevchenko/mcp-memory-graph-enhanced** | Enhanced Anthropic memory | JSONL + Neo4j | Timestamps, confidence scoring, BFS pathfinding |
| **OMEGA** | Local-first semantic store | SQLite + ONNX embeddings | 12 tools, zero cloud dependency |
| **Memora** (agentic-mcp-tools) | Semantic memory + knowledge graph | SQLite + optional cloud (S3, R2) | 313 stars, hierarchical organization, graph visualization |
| **_rendro's MCP server** | Hybrid search + property graph | Vector + BM25 | 4-tool API, memory decay (30-day half-life), auto-consolidation |
| **adamrdrew/agent-memory-mcp** | Hybrid search | LanceDB | BM25 + vector cosine via RRF, local ONNX embeddings |
| **SymbolicMemoryMCP** | Symbolic key-value | Explicit symbols | Deterministic recall, no probabilistic search |
| **devmemory-mcp** | Code-aware memory | Project-specific | Read-only codebase window + lightweight memory |
| **claude-memory-mcp** (WhenMoon-afk) | Knowledge graph | SQLite + optional Ollama semantic search | Based on optimal LLM memory research |
| **MemCP** | Multi-graph (inspired by MAGMA) | Recursive language model-inspired | Sleep awareness, based on MIT research |

---

## 8. Key Research Papers

| Paper | Venue | Year | Core Contribution |
|---|---|---|---|
| **A-Mem: Agentic Memory for LLM Agents** | NeurIPS 2025 | 2025 | Zettelkasten-style self-organizing memory; 85-93% token reduction |
| **G-Memory: Tracing Hierarchical Memory for Multi-Agent Systems** | NeurIPS 2025 | 2025 | Hierarchical memory enabling self-evolution in multi-agent systems |
| **HiMem: Hierarchical Long-Term Memory for LLM Long-Horizon Agents** | arXiv | Jan 2026 | Episode + Note dual memory with conflict-aware reconsolidation |
| **Pancake: Hierarchical Memory System for Multi-Agent LLM Serving** | arXiv | Feb 2026 | Memory management for multi-agent serving infrastructure |
| **Language Models Need Sleep** | ICLR 2026 (under review) | 2026 | Sleep paradigm: memory consolidation + dreaming for continual learning |
| **Hindsight is 20/20** | arXiv | Dec 2025 | Memory that retains, recalls, and reflects with evidence separation |
| **HiAgent: Hierarchical Working Memory** | AAAI-adjacent | 2024 | Hierarchical working memory for long-horizon tasks |
| **MemGPT: Towards LLMs as Operating Systems** | ICLR 2024 | 2023 | Virtual context management via memory paging |
| **Zep: Temporal Knowledge Graphs for Agent Memory** | arXiv | Jan 2025 | Temporal KG with episode/semantic/community subgraphs |
| **Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory** | arXiv | 2025 | LLM-as-memory-manager with three-tier storage |
| **ReMemR1: Revisitable Memory for Long-Context LLM Agents** | arXiv | Mar 2026 | "Look back to reason forward" — revisitable memory buffer |
| **Awesome-AI-Memory** (IAAR-Shanghai) | GitHub | Ongoing | Curated knowledge base: 495 stars, comprehensive taxonomy |

---

## 9. Verdict & Recommendations

### For Production Today (March 2026)

1. **Simple sessions (<50 turns):** Sliding window + summary buffer is fine. Don't over-engineer.
2. **Cross-session persistence:** **Mem0** (best accuracy/speed/cost balance) or **Zep/Graphiti** (if you need temporal reasoning)
3. **Self-hosted, privacy-first:** **OMEGA** (SQLite + local ONNX) or **Memora** (313 stars, active development)
4. **MCP-based Claude integration:** Start with official `server-memory`, upgrade to `atomic-memory-mcp` for thread isolation and conflict detection

### For Research / Cutting Edge

1. **Self-organizing memory:** A-Mem (NeurIPS 2025) — proven at conference, code available
2. **Hierarchical with self-evolution:** HiMem — most complete framework for long-horizon agents
3. **Weight-based memory (no retrieval):** Sleeping LLM — fascinating but limited to ~15-60 facts depending on model size. Not production-ready
4. **Sleep consolidation:** Active research frontier — watch ICLR 2026 proceedings

### The Unsolved Problems

- **Scalability:** No system gracefully handles millions of memories across years of interaction
- **Memory quality:** All extraction is LLM-dependent → non-deterministic → occasional hallucination
- **Forgetting:** Controlled forgetting (what to prune and when) remains largely heuristic
- **Evaluation:** No standard benchmark covers all memory capabilities. LongMemEval and DMR exist but are limited
- **Cost:** Graph + vector + LLM extraction = expensive. Local-only alternatives sacrifice quality
- **True continual learning:** Weight-editing approaches (MEMIT) have hard capacity ceilings. The hippocampus→neocortex dream is real but the engineering isn't there yet

---

*Compiled March 14, 2026. Sources: arXiv, NeurIPS 2025, ICLR 2026 submissions, GitHub, Mem0/Zep/Letta documentation, independent benchmarks, LobeHub MCP marketplace.*
