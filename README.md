# remote-copilot-mcp

An MCP (Model Context Protocol) server for remote control of AI assistants via Telegram.

## Overview

This server exposes two tools that allow an AI assistant (e.g. GitHub Copilot) to be operated remotely through a Telegram bot:

| Tool | Description |
|------|-------------|
| `remote_copilot_wait_for_instructions` | Blocks (long-polls Telegram) until a new message arrives or the timeout elapses. Returns the prompt in a format that instructs the agent to act and then call the tool again, keeping the feedback loop alive. |
| `report_progress` | Sends a progress update or result message back to the operator via Telegram. |

## Prerequisites

- Node.js 18 or later (uses native `fetch`)
- A [Telegram bot token](https://core.telegram.org/bots#botfather) (`TELEGRAM_TOKEN`)
- The chat ID of the operator (`TELEGRAM_CHAT_ID`)

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
| `TELEGRAM_CHAT_ID` | ✅ | — | Chat / user ID that the bot will listen to |
| `WAIT_TIMEOUT_MINUTES` | ❌ | `30` | Minutes to wait for a message before timing out |

## Usage

### Run directly

```bash
TELEGRAM_TOKEN=<token> TELEGRAM_CHAT_ID=<chat_id> npm start
```

### Configure in MCP client (e.g. VS Code Copilot)

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "remote-copilot": {
      "command": "node",
      "args": ["/path/to/remote-copilot-mcp/dist/index.js"],
      "env": {
        "TELEGRAM_TOKEN": "<your-bot-token>",
        "TELEGRAM_CHAT_ID": "<your-chat-id>",
        "WAIT_TIMEOUT_MINUTES": "30"
      }
    }
  }
}
```

## How it works

1. The AI assistant calls `remote_copilot_wait_for_instructions`.
2. The server long-polls the Telegram Bot API (`getUpdates`) in 45-second windows until a message is received or the configured timeout elapses.
3. When a message arrives the tool returns:
   > *Follow the instructions: \<prompt\>. Create plan, use subagents. Use web search for framework/pattern related concerns. Use report_progress tool to proactively report progress to the user. After you're done (don't skip this step), call remote_copilot_wait_for_instructions again to keep the feedback loop alive*
4. If the timeout elapses with no message the tool returns a notice instructing the assistant to call `remote_copilot_wait_for_instructions` again.
5. At any point the assistant can call `report_progress` to send a status update back to the Telegram chat.

## Development

```bash
# Run in development mode (no build step needed)
TELEGRAM_TOKEN=<token> TELEGRAM_CHAT_ID=<chat_id> npm run dev

# Compile TypeScript
npm run build
```
