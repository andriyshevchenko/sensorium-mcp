[![npm version](https://img.shields.io/npm/v/sensorium-mcp)](https://www.npmjs.com/package/sensorium-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

# sensorium-mcp

MCP server with 5-layer memory, voice analysis, and Telegram bridge for AI assistants.

## Why?

AI assistants forget everything between sessions. Every restart is a blank slate — no memory of your preferences, past decisions, or ongoing projects. Voice messages arrive as opaque audio blobs. And there's no way to talk to your agent when it's running headless in CI or on a remote machine.

**sensorium-mcp** fixes all three problems:

- **Persistent memory** that survives across sessions, automatically capturing episodes and consolidating knowledge
- **Voice understanding** with transcription and real-time emotion analysis
- **Remote control** via Telegram — give instructions, send files, receive progress updates from anywhere

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
        "OPENAI_API_KEY": "...",
        "WAIT_TIMEOUT_MINUTES": "30"
      }
    }
  }
}
```

Then tell your agent:

```
Start remote copilot session
```

## Features

### 5-Layer Memory System

Every operator message is automatically captured. Knowledge is extracted and consolidated during idle time using a configurable LLM (default: `gpt-4o-mini`).

| Layer | What it stores |
|-------|---------------|
| **Working Memory** | Current session context — active goals, recent messages |
| **Episodic Memory** | Auto-saved conversation episodes (every operator message) |
| **Semantic Memory** | Extracted facts, preferences, patterns, entities, relationships |
| **Procedural Memory** | Multi-step procedures and workflows |
| **Meta-Memory** | Confidence scores, decay tracking, topic indexing |

Storage: SQLite at `~/.sensorium-mcp/memory.db`. No external database required.

**Auto-bootstrap** — session start auto-injects a memory briefing so the agent immediately knows who you are and what you've been working on.

**Auto-ingest** — every operator message is saved as an episode automatically.

**Intelligent consolidation** — a configurable LLM analyzes accumulated episodes and extracts durable knowledge (facts, preferences, patterns) during idle periods.

### Remote Control via Telegram

Operate your AI assistant from anywhere through a Telegram forum supergroup.

- Concurrent sessions with a shared file-based dispatcher (no 409 conflicts)
- Named session persistence across VS Code restarts
- Image, document, and video note support
- Voice messages with Whisper transcription
- Automatic Markdown → Telegram MarkdownV2 conversion

### Voice Analysis

Real-time voice emotion analysis via an optional microservice (see `voice-analysis/`).

- Detects emotions, gender, arousal/dominance/valence
- Video note (circle video) support with audio extraction
- Deployable via Docker

### Scheduler

Schedule tasks that fire during `wait_for_instructions`.

- **One-shot**: `runAt` — trigger at a specific time
- **Idle-triggered**: `afterIdleMinutes` — trigger after N minutes of inactivity

## Tools

| Tool | Description |
|------|-------------|
| `start_session` | Begin or resume a session with optional memory bootstrap |
| `remote_copilot_wait_for_instructions` | Block until operator message, scheduled task, or timeout |
| `report_progress` | Send Markdown progress update to operator |
| `send_file` | Send file or image to operator |
| `send_voice` | Text-to-speech voice message via OpenAI TTS |
| `schedule_wake_up` | Schedule a one-shot or idle task |
| `memory_bootstrap` | Load memory briefing into context |
| `memory_search` | Search episodic/semantic memory by query |
| `memory_save` | Save a fact, preference, pattern, entity, or relationship |
| `memory_save_procedure` | Save a multi-step procedure |
| `memory_update` | Update or supersede an existing note |
| `memory_consolidate` | Run intelligent consolidation |
| `memory_status` | Check memory health and statistics |
| `memory_forget` | Delete a specific memory note |

## Data Privacy

### Memory Consolidation
The memory system periodically sends conversation excerpts to OpenAI's API for knowledge extraction and consolidation. This helps maintain useful context across sessions.

To disable this behavior, set the environment variable:
```
CONSOLIDATION_ENABLED=false
```

When disabled, the memory system will still store episodes locally but will not send them to OpenAI for consolidation.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_TOKEN` | Yes | — | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | Yes | — | Forum supergroup chat ID |
| `TELEGRAM_SUPERVISOR_TOKEN` | No | — | Separate bot token for supervisor DM commands (avoids 409 conflict with MCP poller) |
| `OPENAI_API_KEY` | No | — | For voice transcription (Whisper), TTS, and memory consolidation |
| `VOICE_ANALYSIS_URL` | No | — | Voice emotion analysis microservice URL |
| `CONSOLIDATION_ENABLED` | No | `true` | Set to `false` or `0` to disable sending episodes to OpenAI for consolidation |
| `CONSOLIDATION_MODEL` | No | `gpt-4o-mini` | OpenAI model for memory consolidation |
| `MCP_HTTP_PORT` | No | — | If set, starts HTTP/SSE transport on this port instead of stdio |
| `WAIT_TIMEOUT_MINUTES` | No | `120` | Wait timeout in minutes |

## Prerequisites

- Node.js 18+ (uses native `fetch`)
- A [Telegram bot token](https://core.telegram.org/bots#botfather)
- A Telegram **forum supergroup** with the bot as admin (Manage Topics right)

## Transport Modes

**stdio (default)** — standard MCP transport. Used with `npx sensorium-mcp@latest`.

**HTTP/SSE** — set `MCP_HTTP_PORT` to start an HTTP server. Useful for development (restart server without restarting VS Code) or remote connections:

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
MCP_HTTP_PORT=3847 TELEGRAM_TOKEN=... TELEGRAM_CHAT_ID=... node dist/index.js
```

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

If the watcher is not configured, the maintenance response falls back to a Desktop Commander sleep command.

## Supervisor Install (Windows)

Use the distribution installer at the repository/package root:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Sensorium.ps1
```

Default behavior installs the supervisor binary under `~/.remote-copilot-mcp/bin/`, adds a `shell:startup` launcher for the current user, and starts the supervisor immediately.

If you explicitly pass `-ServiceUser` while running as Administrator, the installer configures a Windows Service instead.

For local SecureVault setups, prefer the default user-context startup mode so profile-scoped secrets resolve under your user account.

## How It Works

1. `start_session` creates a Telegram topic (or resumes one by name). Memory bootstrap auto-loads your context.
2. A shared **dispatcher** runs a single `getUpdates` poller (elected via lock file). Messages are written to per-thread JSONL files — each MCP instance reads its own.
3. Incoming messages (text, photo, document, voice, video note) are processed, transcribed, and delivered as MCP content blocks. Every operator message is auto-saved as an episode.
4. The agent works, calls `report_progress` / `send_file` / `send_voice`, and loops back to `wait_for_instructions`.
5. During idle periods, the scheduler fires pending tasks and memory consolidation extracts durable knowledge from episodes.

## Architecture

```
~/.sensorium-mcp/
  poller.lock                 ← PID + timestamp; first instance becomes the poller
  offset                      ← shared getUpdates offset
  memory.db                   ← SQLite: episodes, semantic notes, procedures, voice signatures
  threads/
    <threadId>.jsonl           ← messages for each topic thread
    general.jsonl              ← messages with no thread ID
~/.sensorium-mcp-sessions.json  ← name → threadId mapping
```

## License

[MIT](LICENSE)
