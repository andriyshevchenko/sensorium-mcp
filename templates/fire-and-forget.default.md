---
name: Fire and Forget
triggers:
  - fire and forget
  - background task
  - spawn autonomous thread
  - thread delegation no wait
replaces_orchestrator: true
---

## Fire and Forget — Autonomous Worker Pattern

### Overview
This skill describes the **fire-and-forget** pattern: you spawn a ghost thread, send it a task, and **continue working immediately**. The worker executes autonomously and reports progress directly to the **operator** (not back to you).

### When to Use
- Background cleanup tasks (log rotation, stale file removal)
- Scheduled improvements that don't affect current work
- Logging, monitoring, metrics collection
- Any task where the result does NOT gate your next step
- Long-running tasks you don't need to wait on

### When NOT to Use
- Code reviews (you need the findings)
- Any task where the output determines your next action
- Tasks that modify files you're also editing (conflict risk)
- Work with acceptance criteria you need to verify → use **Delegate and Wait** instead

### Core Pattern

#### Step 1 — Spawn the worker thread
```
start_thread(
  name: "Background Cleanup",
  task: "You handle background maintenance tasks autonomously."
)
→ returns { threadId: <WORKER_THREAD_ID> }
```

#### Step 2 — Send the task with worker skill
```
send_message_to_thread(
  threadId: <WORKER_THREAD_ID>,
  message: "Load the 'Worker — Autonomous' skill via get_skill for reporting instructions.
  
  Task: Clean up stale log files older than 30 days in ~/.remote-copilot-mcp/logs/."
)
```

**KEY**: The task includes `Load the 'Worker — Autonomous' skill via get_skill` which teaches the worker to report to the **operator** directly using `report_progress` or `send_voice` — not back to the orchestrator.

#### Step 3 — Continue working immediately
Do NOT call `wait_for_instructions` for this worker. Continue with your own work. The worker runs independently.

### Worker Behavior
The autonomous worker should:
- Execute the task independently
- Report progress to the **operator** via `report_progress` or `send_voice`
- NOT send messages back to the orchestrator thread
- Handle errors gracefully and notify the operator if something fails

### Rules

- **NEVER** call `wait_for_instructions` after a fire-and-forget delegation.
- **ALWAYS** tell the worker to report to the operator, not back to the orchestrator.
- **ALWAYS** include explicit instructions like "Do NOT message the sender back."
- Use this pattern only when the result doesn't affect your immediate work.
- If you later realize you need the result, spawn a new **Delegate and Wait** task instead.

### Anti-Patterns

- ❌ Waiting on a fire-and-forget worker (defeats the purpose)
- ❌ Worker sending results back to the orchestrator instead of the operator
- ❌ Using fire-and-forget for tasks that gate your next step
- ❌ Spawning fire-and-forget workers that modify files you're actively editing
- ❌ Forgetting to tell the worker how to report progress (operator gets no visibility)
