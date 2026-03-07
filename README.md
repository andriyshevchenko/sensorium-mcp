# remote-copilot-mcp

An MCP (Model Context Protocol) server for remote control of AI assistants via Telegram.

## Overview

This server exposes three tools that allow an AI assistant (e.g. GitHub Copilot) to be operated remotely through a Telegram bot:

| Tool | Description |
|------|-------------|
| `start_session` | Begin a remote-copilot session. Automatically creates a dedicated Telegram topic thread in the forum supergroup so each session is fully isolated. |
| `remote_copilot_wait_for_instructions` | Blocks (long-polls Telegram) until a new message arrives in the active topic or the timeout elapses. |
| `report_progress` | Sends a progress update back to the operator in the active topic thread, using standard Markdown (auto-converted to Telegram MarkdownV2). |

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
| `WAIT_TIMEOUT_MINUTES` | ❌ | `30` | Minutes to wait for a message before timing out |

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

1. The AI calls `start_session`, which **automatically creates a new Telegram topic** (e.g. *Copilot — 07 Mar 2026, 14:30*) in the forum supergroup. All sends and receives for this session are scoped to that thread, so multiple parallel sessions never interfere.
2. The server long-polls the Telegram Bot API (`getUpdates`) in 45-second windows, filtering messages by the active topic's `message_thread_id`.
3. When a message arrives the tool instructs the AI to act on it, then call `remote_copilot_wait_for_instructions` again to keep the loop alive.
4. If the timeout elapses with no message the tool tells the AI to call the tool again immediately (with a unique timestamp so VS Code's loop-detection heuristic is not triggered).
5. At any point the AI calls `report_progress` to post a status update to the active topic thread. The message is written in standard Markdown and automatically converted to Telegram MarkdownV2. Intermediate operator messages are also surfaced so they are not missed.
