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

## Quickstart

```bash
npx sensorium-mcp@latest
```

Or add to your VS Code `mcp.json`:

```json
{
  "servers": {
    "sensorium-mcp": {
      "command": "npx",
      "args": ["sensorium-mcp@latest"],
      "env": {
        "TELEGRAM_TOKEN": "...",
        "TELEGRAM_CHAT_ID": "...",
        "OPENAI_API_KEY": "..."
      }
    }
  }
}
```

Then tell your agent:

```
Start remote copilot session
```

## Setup

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot
2. Copy the bot token — this is your `TELEGRAM_TOKEN`

### 2. Create a forum supergroup

1. Create a Telegram group and convert it to a supergroup
2. Enable **Topics** in group settings (this makes it a forum supergroup)
3. Add your bot as admin with **Manage Topics** permission
4. Get the chat ID (you can use [@userinfobot](https://t.me/userinfobot) or the Telegram API)

### 3. Set environment variables

**Option A: `.env` file** (simplest)

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

**Option B: MCP config** (VS Code / Claude Desktop)

Pass variables directly in your MCP server configuration (see Quickstart above).

**Option C: SecureVault** (production)

If you have [SecureVault](https://github.com/nicepkg/securevault) installed, the install script uses it automatically. Configure a profile named `SENSORIUM` with your secrets.

### 4. (Optional) Get an OpenAI API key

Required for voice transcription (Whisper), text-to-speech (`send_voice`), and memory consolidation. Without it, the server still works but voice features and consolidation are disabled.

## Features

### Multi-Layer Memory System

Every operator message is automatically captured. Knowledge is extracted and consolidated during idle time using a configurable LLM (default: `gpt-4o`).

| Layer | What it stores |
|-------|---------------|
| **Working Memory** | Current session context — active goals, recent messages |
| **Episodic Memory** | Auto-saved conversation episodes (every operator message) |
| **Semantic Memory** | Extracted facts, preferences, patterns, entities, relationships |
| **Meta-Memory** | Confidence scores, quality scoring, topic indexing, causal links |

Storage: SQLite at `~/.sensorium-mcp/memory.db`. No external database required.

**Auto-bootstrap** — session start auto-injects a memory briefing so the agent immediately knows who you are and what you've been working on.

**Auto-ingest** — every operator message is saved as an episode automatically.

**Intelligent consolidation** — a configurable LLM analyzes accumulated episodes and extracts durable knowledge (facts, preferences, patterns) during idle periods. Includes deduplication, quality scoring, and causal linking.

### Remote Control via Telegram

Operate your AI assistant from anywhere through a Telegram forum supergroup.

- Concurrent sessions with a shared file-based dispatcher (no 409 conflicts)
- Named session persistence across VS Code restarts
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

Threads can communicate via `send_message_to_thread` and coordinate work across multiple agents.

### Voice Analysis

Real-time voice emotion analysis via an optional microservice (see `voice-analysis/`).

- Detects emotions, gender, arousal/dominance/valence
- Video note (circle video) support with audio extraction
- Deployable via Docker

### Scheduler

Schedule tasks that fire during `wait_for_instructions`.

- **One-shot**: `runAt` — trigger at a specific time
- **Idle-triggered**: `afterIdleMinutes` — trigger after N minutes of inactivity

### Skills System

Customizable prompt templates that agents can discover and load on demand.

- `search_skills` — find relevant skills by keyword
- `get_skill` — load a specific skill template
- Templates stored in `~/.sensorium-mcp/templates/` with `{{VARIABLE}}` bindings

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
| `schedule_wake_up` | Schedule a one-shot or idle-triggered task |
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
| `MCP_HTTP_PORT` | No | — | Enable HTTP/SSE transport on this port (required for multi-thread spawning) |
| `MCP_HTTP_SECRET` | No | — | Shared secret for HTTP transport authentication |
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

## Prerequisites

- Node.js 18+ (uses native `fetch`)
- A [Telegram bot token](https://core.telegram.org/bots#botfather)
- A Telegram **forum supergroup** with the bot as admin (Manage Topics right)

## Transport Modes

**stdio (default)** — standard MCP transport. Used with `npx sensorium-mcp@latest`.

**HTTP/SSE** — set `MCP_HTTP_PORT` to start an HTTP server. Required for multi-thread agent spawning. Useful for development (restart server without restarting VS Code) or remote connections:

```json
{
  "servers": {
    "sensorium-mcp": {
      "type": "streamableHttp",
      "url": "http://localhost:3847/mcp"
    }
  }
}
```

Start the server separately:
```bash
MCP_HTTP_PORT=3847 TELEGRAM_TOKEN=... TELEGRAM_CHAT_ID=... npx sensorium-mcp@latest
```

## Data Privacy

### Memory Consolidation
The memory system periodically sends conversation excerpts to OpenAI's API for knowledge extraction and consolidation. This helps maintain useful context across sessions.

To disable this behavior, set the environment variable:
```
CONSOLIDATION_ENABLED=false
```

When disabled, the memory system still stores episodes locally but does not send them to OpenAI for consolidation.

## Watcher MCP Server

During server updates, the main `sensorium-mcp` process restarts and cannot accept tool calls. The **watcher** is a lightweight sidecar that stays alive across updates — agents call its `await_server_ready` tool and block until the new version is ready.

Add it alongside `sensorium-mcp` in your agent's MCP config:

**VS Code Copilot** (`mcp.json`):
```json
{
  "servers": {
    "sensorium-mcp": { "..." : "..." },
    "sensorium-watcher": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sensorium-mcp@latest", "--watcher"]
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "sensorium-watcher": {
      "command": "npx",
      "args": ["-y", "sensorium-mcp@latest", "--watcher"]
    }
  }
}
```

If the watcher is not configured, the maintenance response falls back to a sleep command.

## Supervisor (Windows)

The supervisor is a companion binary that manages the MCP server lifecycle — auto-restarts on crash, handles updates, and runs as a background process.

### Install

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Sensorium.ps1
```

The installer:
1. Downloads the supervisor binary from GitHub Releases
2. Installs a startup launcher in `shell:startup`
3. Loads secrets from **SecureVault** (if available) or a **`.env` file** in the current directory
4. Starts the supervisor in the background

Configuration is stored in `~/.remote-copilot-mcp/install.config.json`.

## How It Works

1. `start_session` creates a Telegram topic (or resumes one by name). Memory bootstrap auto-loads your context.
2. A shared **dispatcher** runs a single `getUpdates` poller (elected via lock file). Messages are written to per-thread JSONL files — each MCP instance reads its own.
3. Incoming messages (text, photo, document, voice, video note) are processed, transcribed, and delivered as MCP content blocks. Every operator message is auto-saved as an episode.
4. The agent works, calls `report_progress` / `send_file` / `send_voice`, and loops back to `wait_for_instructions`.
5. During idle periods, the scheduler fires pending tasks, memory consolidation extracts durable knowledge from episodes, and reflection/narrative pipelines generate temporal context.

## Architecture

```
~/.sensorium-mcp/
  memory.db                   <- SQLite: episodes, semantic notes, voice signatures, thread registry
  settings.json               <- Per-thread agent types, keep-alive, conversation modes
  poller.lock                 <- PID + timestamp; first instance becomes the poller
  offset                      <- Shared getUpdates offset
  server.pid                  <- Authoritative PID for supervisor and self-update
  templates/                  <- Skill templates (*.default.md)
  threads/
    <threadId>.jsonl           <- Messages for each topic thread
    general.jsonl              <- Messages with no thread ID
  bin/
    sensorium-supervisor.exe   <- Supervisor binary (Windows)
  logs/
    threads/                   <- Per-thread agent logs
```

## License

[MIT](LICENSE)
