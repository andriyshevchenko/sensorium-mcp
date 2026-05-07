[![npm version](https://img.shields.io/npm/v/sensorium-mcp)](https://www.npmjs.com/package/sensorium-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

# sensorium-mcp

MCP server with multi-layer memory, voice analysis, multi-thread orchestration, and Telegram bridge for AI assistants.

## Why?

AI assistants forget everything between sessions. Every restart is a blank slate — no memory of your preferences, past decisions, or ongoing projects. Voice messages arrive as opaque audio blobs. And there's no way to talk to your agent when it's running headless in CI or on a remote machine.

**sensorium-mcp** fixes all three problems:

- **Persistent memory** that survives across sessions, automatically capturing episodes and consolidating knowledge
- **Voice understanding** with transcription and real-time emotion analysis
- **Remote control** via Telegram — give instructions, send files, receive progress updates from anywhere
- **Multi-thread orchestration** — spawn worker, branch, and daily threads with shared or isolated memory

## Getting Started

### Prerequisites

- Windows 10/11 (supervisor is Windows-only; the MCP server itself is cross-platform)
- Node.js 18+
- A [Telegram bot token](https://core.telegram.org/bots#botfather)
- A Telegram **forum supergroup** with the bot as admin (Manage Topics right)

### 1. Create a Telegram bot and forum group

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot — copy the token
2. Create a Telegram group, convert to supergroup, and enable **Topics** in settings
3. Add your bot as admin with **Manage Topics** permission
4. Get the chat ID (use [@userinfobot](https://t.me/userinfobot) or the Telegram API)

### 2. Create a `.env` file

Copy `.env.example` to `.env` in the directory where you'll run the installer:

```bash
cp .env.example .env
```

Fill in at minimum `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID`. Add `OPENAI_API_KEY` for voice and memory consolidation features. Set `MCP_HTTP_PORT` (e.g. `3847`) to enable multi-thread agent spawning.

If you have [SecureVault](https://github.com/nicepkg/securevault) installed, the installer uses it automatically instead of `.env`.

### 3. Install and run

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Sensorium.ps1
```

This downloads the supervisor binary, installs a startup launcher, loads secrets (from SecureVault or `.env`), and starts the supervisor in the background. The supervisor manages the MCP server lifecycle — spawning, health checks, auto-restart on crash, and coordinating updates.

Configuration is stored in `~/.remote-copilot-mcp/install.config.json`.

### 4. Use it

The supervisor starts the MCP server on the configured HTTP port. When the server spawns agent threads (Claude, Copilot, Codex), it automatically generates per-thread MCP configs and injects them — no manual `mcp.json` setup needed.

Tell your agent:

```
Start remote copilot session
```

### Running without the supervisor

For development or quick testing, run the MCP server directly:

```bash
# HTTP transport (recommended — required for multi-thread spawning)
MCP_HTTP_PORT=3847 TELEGRAM_TOKEN=... TELEGRAM_CHAT_ID=... npx sensorium-mcp@latest

# stdio transport (simplest, for single-session use)
npx sensorium-mcp@latest
```

## Features

### Multi-Layer Memory System

Every operator message is automatically captured. Knowledge is extracted and consolidated during idle time using a configurable LLM (default: `gpt-4o`).

| Layer | What it stores |
|-------|---------------|
| **Working Memory** | Current session context — active goals, recent messages |
| **Episodic Memory** | Auto-saved conversation episodes (every operator message) |
| **Semantic Memory** | Extracted facts, preferences, patterns, entities, relationships |
| **Meta-Memory** | Confidence scores, quality scoring, topic indexing, causal links |

Storage: SQLite at `~/.remote-copilot-mcp/memory.db`. No external database required.

**Auto-bootstrap** — session start auto-injects a memory briefing so the agent immediately knows who you are and what you've been working on.

**Auto-ingest** — every operator message is saved as an episode automatically.

**Intelligent consolidation** — a configurable LLM analyzes accumulated episodes and extracts durable knowledge (facts, preferences, patterns) during idle periods. Includes deduplication, quality scoring, and causal linking.

### Remote Control via Telegram

Operate your AI assistant from anywhere through a Telegram forum supergroup.

- Concurrent sessions with a shared file-based dispatcher (no 409 conflicts)
- Named session persistence across restarts
- Image, document, and video note support
- Voice messages with Whisper transcription
- Automatic Markdown to Telegram MarkdownV2 conversion

### Multi-Thread Orchestration

Spawn and manage multiple agent threads from a single session.

| Mode | Purpose |
|------|---------|
| **root** | Standalone persistent thread with its own memory |
| **branch** | Fork of a root thread — copies memory at fork time, then independent |
| **worker** | Temporary task executor — reads parent memory, writes to own (discarded later) |
| **daily** | Daily session for a root thread — reads and writes to the root's memory |
| **resume** | Restart an existing dormant thread as-is (requires `targetThreadId`) |

Threads can communicate via `send_message_to_thread` and coordinate work across multiple agents.

### Voice Analysis

Real-time voice emotion analysis via an optional microservice (see `voice-analysis/`).

- Detects emotions, gender, arousal/dominance/valence
- Video note (circle video) support with audio extraction
- Deployable via Docker

### Scheduler

Schedule tasks that fire during `wait_for_instructions`.

- **One-shot**: `runAt` — trigger at a specific time
- **Cron**: `cron` — recurring schedule using 5-field cron expressions
- **Idle-triggered**: `afterIdleMinutes` — trigger after N minutes of inactivity

### Skills System

Customizable prompt templates that agents can discover and load on demand.

- `search_skills` — find relevant skills by keyword
- `get_skill` — load a specific skill template
- Templates stored in `~/.remote-copilot-mcp/templates/` with `{{VARIABLE}}` bindings

## Tools

| Tool | Description |
|------|-------------|
| `start_session` | Begin or resume a Telegram session with memory bootstrap |
| `remote_copilot_wait_for_instructions` | Block until operator message, scheduled task, or timeout |
| `report_progress` | Send Markdown progress update to operator |
| `send_file` | Send file or image to operator |
| `send_voice` | Text-to-speech voice message via OpenAI TTS |
| `send_sticker` | Send a Telegram sticker |
| `send_message_to_thread` | Send a message to another thread's agent |
| `start_thread` | Spawn a worker, branch, daily, or root thread |
| `get_threads_health` | Show thread status, PIDs, last activity |
| `schedule_wake_up` | Schedule a one-shot, cron, or idle-triggered task |
| `memory_search` | Search episodic/semantic memory by query |
| `memory_save` | Save a fact, preference, pattern, entity, or relationship |
| `memory_update` | Update or supersede an existing note |
| `memory_consolidate` | Run intelligent consolidation |
| `memory_status` | Check memory health and statistics |
| `memory_forget` | Delete a specific memory note |
| `search_skills` | Search available skill templates |
| `get_skill` | Load a skill template by name |
| `get_version` | Get the server version |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_TOKEN` | Yes | — | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | Yes | — | Forum supergroup chat ID |
| `OPENAI_API_KEY` | No | — | For voice transcription (Whisper), TTS, and memory consolidation |
| `MCP_HTTP_PORT` | No | — | Enable HTTP transport on this port (required for multi-thread spawning) |
| `MCP_HTTP_SECRET` | No | — | Shared secret for HTTP transport auth (recommended when `MCP_HTTP_PORT` is set) |
| `MCP_HTTP_BIND` | No | `127.0.0.1` | Bind address for HTTP server |
| `TELEGRAM_SUPERVISOR_TOKEN` | No | — | Separate bot token for supervisor DM commands (avoids 409 conflict) |
| `VOICE_ANALYSIS_URL` | No | — | Voice emotion analysis microservice URL |
| `CONSOLIDATION_ENABLED` | No | `true` | Set to `false` to disable sending episodes to OpenAI for consolidation |
| `CONSOLIDATION_MODEL` | No | `gpt-4o` | OpenAI model for memory consolidation |
| `REFLECTION_MODEL` | No | — | Model for reflection pipeline (falls back to `CONSOLIDATION_MODEL`) |
| `NARRATIVE_MODEL` | No | — | Model for narrative generation (falls back to `CONSOLIDATION_MODEL`) |
| `WAIT_TIMEOUT_MINUTES` | No | `1440` | How long `wait_for_instructions` blocks (minutes) |
| `AUTONOMOUS_MODE` | No | `false` | Enable autonomous agent behavior |
| `DMN_ACTIVATION_HOURS` | No | `4` | Hours of idle before DMN reflection fires |
| `DEBUG` | No | — | Enable debug-level logging |

## Data Privacy

The memory system periodically sends conversation excerpts to OpenAI's API for knowledge extraction and consolidation. To disable:

```
CONSOLIDATION_ENABLED=false
```

When disabled, episodes are still stored locally but not sent to OpenAI.

## How It Works

1. `start_session` creates a Telegram topic (or resumes one by name). Memory bootstrap auto-loads your context.
2. A shared **dispatcher** runs a single `getUpdates` poller (elected via lock file). Messages are written to per-thread JSONL files — each MCP instance reads its own.
3. Incoming messages (text, photo, document, voice, video note) are processed, transcribed, and delivered as MCP content blocks. Every operator message is auto-saved as an episode.
4. The agent works, calls `report_progress` / `send_file` / `send_voice`, and loops back to `wait_for_instructions`.
5. During idle periods, the scheduler fires pending tasks, memory consolidation extracts durable knowledge from episodes, and reflection/narrative pipelines generate temporal context.

## Architecture

```
~/.remote-copilot-mcp/
  memory.db                   <- SQLite: episodes, semantic notes, voice signatures, thread registry
  settings.json               <- Per-thread agent types, keep-alive, conversation modes
  install.config.json          <- Installer configuration (SecureVault profile, update mode)
  poller.lock                 <- PID + timestamp; first instance becomes the poller
  offset                      <- Shared getUpdates offset
  server.pid                  <- Authoritative PID for supervisor and self-update
  templates/                  <- Skill templates (*.default.md)
  threads/
    <threadId>.jsonl           <- Messages for each topic thread
  bin/
    sensorium-supervisor.exe   <- Supervisor binary (Windows)
  logs/
    threads/                   <- Per-thread agent logs
```

## License

[MIT](LICENSE)
