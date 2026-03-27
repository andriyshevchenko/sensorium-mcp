---
name: Ghost Thread
triggers:
  - ghost thread
  - ghost worker
  - spawn ghost
  - use ghost
replaces_orchestrator: true
---

# Ghost Thread Skill

## What is a Ghost Thread?
A ghost thread is a worker thread that inherits the parent thread's memory context at startup. It has its own unique thread ID and Telegram topic, but its initial memory briefing comes from the parent thread. This gives it full context — decisions, preferences, past work — without the overhead of re-explaining everything.

## When to Use Ghost Threads
- **Complex tasks** that need the parent's full context (code reviews, refactors, investigations)
- **Parallel execution** — spawn multiple ghosts for non-blocking concurrent work
- **Context isolation** — ghost writes to its own memory scope, so intermediate work doesn't pollute the parent

## How to Spawn a Ghost Thread

Call `start_thread` with the `memorySourceThreadId` parameter:

```json
{
  "name": "code-review-ghost",
  "task": "Review src/server/factory.ts for dead code and type safety",
  "memorySourceThreadId": <your current thread ID>
}
```

The ghost thread will:
1. Get its own Telegram topic and unique thread ID
2. Receive memory briefing from the parent's thread ID
3. Run independently and non-blocking
4. Write episodes/notes to its own scope (no parent contamination)

## Sending Work to a Ghost

After spawning, use `send_message_to_thread` to assign tasks:

```json
{
  "threadId": <ghost thread ID>,
  "message": "Review these files: src/config.ts, src/index.ts. Focus on dead code."
}
```

## Getting Results Back

The ghost thread sends results back via `send_message_to_thread` to the parent's thread ID.

## Pattern: Orchestrator + Ghost Workers

1. Orchestrator receives a complex task
2. Spawns ghost threads with `memorySourceThreadId` set to orchestrator's thread
3. Sends specific sub-tasks to each ghost via `send_message_to_thread`
4. Ghost workers execute using subagents
5. Ghosts report results back via `send_message_to_thread`
6. Orchestrator aggregates results

## Anti-Patterns
- **DON'T** use ghost threads for simple tasks — just use a subagent
- **DON'T** spawn more ghosts than needed — each consumes a Copilot session
- **DON'T** expect ghost threads to share runtime state — they only share initial memory
- **DON'T** have ghosts write to the parent's memory — they have their own scope
