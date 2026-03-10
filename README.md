# remote-copilot-mcp

An MCP (Model Context Protocol) server for remote control of AI assistants via Telegram.

## Overview

This server exposes four tools that allow an AI assistant (e.g. GitHub Copilot) to be operated remotely through a Telegram bot:

| Tool | Description |
|------|-------------|
| `start_session` | Begin or resume a remote-copilot session. Creates a dedicated Telegram topic thread (or resumes an existing one by name or thread ID). |
| `remote_copilot_wait_for_instructions` | Blocks until a new message (text, photo, document, or voice) arrives in the active topic or the timeout elapses. |
| `report_progress` | Sends a progress update back to the operator using standard Markdown (auto-converted to Telegram MarkdownV2). |
| `send_file` | Sends a file or image to the operator via Telegram (base64-encoded). Images are sent as photos; everything else as documents. |
| `send_voice` | Sends a voice message to the operator via Telegram. Text is converted to speech using OpenAI TTS (max 4096 chars). |

## Features

- **Concurrent sessions** — Multiple VS Code windows can run independent sessions simultaneously. A shared file-based dispatcher ensures only one process polls Telegram (`getUpdates`), while each session reads from its own per-thread message file. No 409 conflicts, no lost updates.
- **Named session persistence** — Sessions are mapped by name to Telegram thread IDs in `~/.remote-copilot-mcp-sessions.json`. Calling `start_session({ name: "Fix auth bug" })` always resumes the same thread, even across VS Code restarts.
- **Image & document support** — Send photos or documents to the agent from Telegram; the agent receives them as native MCP image content blocks or base64 text. The agent can also send files back via the `send_file` tool.
- **Voice message support** — Send voice messages from Telegram; they are automatically transcribed using OpenAI Whisper and delivered as text to the agent. The agent can also send voice responses back via OpenAI TTS. Requires `OPENAI_API_KEY`.
- **Automatic Markdown conversion** — Standard Markdown in `report_progress` is automatically converted to Telegram MarkdownV2, including code blocks, tables, blockquotes, and special characters.
- **Keep-alive pings** — Periodic heartbeat messages to Telegram so the operator knows the agent is still alive during long idle periods.

## Prerequisites

- Node.js 18 or later (uses native `fetch`)
- A [Telegram bot token](https://core.telegram.org/bots#botfather) (`TELEGRAM_TOKEN`)
- A Telegram **forum supergroup** where the bot is an admin with the **Manage Topics** right
  - In Telegram: create a group → *Edit → Topics → Enable*
  - Add your bot as admin and grant it *Manage Topics*
  - Copy the group's chat ID (e.g. `-1001234567890`) as `TELEGRAM_CHAT_ID`

## Installation

```bash
npm install
npm run build
```

## Configuration

Set the following environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_TOKEN` | ✅ | — | Telegram Bot API token from @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | — | Chat ID of the forum supergroup (e.g. `-1001234567890`). The bot must be admin with Manage Topics right. |
| `WAIT_TIMEOUT_MINUTES` | ❌ | `120` | Minutes to wait for a message before timing out |
| `OPENAI_API_KEY` | ❌ | — | OpenAI API key for voice message transcription (Whisper). Without it, voice messages show a placeholder instead of a transcript. |

## Usage

### Simply use this prompt

```bash
Start remote copilot session
```

### Configure in MCP client (e.g. VS Code Copilot)

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "remote-copilot-mcp": {
      "command": "npx",
      "args": [
        "remote-copilot-mcp@latest"
      ],
      "env": {
        "TELEGRAM_TOKEN": "${input:TELEGRAM_TOKEN}",
        "TELEGRAM_CHAT_ID": "${input:TELEGRAM_CHAT_ID}",
        "WAIT_TIMEOUT_MINUTES": "30"
      },
      "type": "stdio"
    }
  }
}
```

## How it works

1. The AI calls `start_session`, which creates a new Telegram topic (e.g. *Copilot — 07 Mar 2026, 14:30*) or resumes an existing one by name/thread ID.
2. A shared **dispatcher** runs a single `getUpdates` poller (elected via a lock file at `~/.remote-copilot-mcp/poller.lock`). It writes incoming messages to per-thread JSONL files under `~/.remote-copilot-mcp/threads/`. Each MCP instance reads from its own thread file — no 409 conflicts between concurrent sessions.
3. When a message arrives (text, photo, or document), the tool downloads any media, converts it to MCP content blocks (image or text with base64), and instructs the AI to act on it.
4. The AI calls `report_progress` to post status updates and `send_file` to send files/images back to the operator.
5. If the timeout elapses with no message, the tool tells the AI to call `remote_copilot_wait_for_instructions` again immediately.

### Architecture

```
~/.remote-copilot-mcp/
  poller.lock                 ← PID + timestamp; first instance becomes the poller
  offset                      ← shared getUpdates offset
  threads/
    <threadId>.jsonl           ← messages for each topic thread
    general.jsonl              ← messages with no thread ID
~/.remote-copilot-mcp-sessions.json  ← name → threadId mapping
```
