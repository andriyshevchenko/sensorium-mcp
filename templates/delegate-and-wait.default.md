---
name: Delegate and Wait
triggers:
  - delegate to thread
  - delegate and wait
  - orchestrator worker
  - spawn thread and wait
  - use multi-thread
replaces_orchestrator: true
---

## Delegate and Wait — Orchestrator-Worker Pattern

### Overview
This skill describes the **orchestrator-worker** pattern: you spawn a ghost thread, send it a task, and **wait** for the result. The orchestrator does NOT do the work — it delegates, waits, and processes the response.

### When to Use
- Code reviews (you need the findings to act on)
- Any task where the output determines your next action
- Work that requires specialist domain context (dashboard, testing, refactoring)
- Tasks with acceptance criteria you need to verify

### Core Pattern

#### Step 1 — Spawn the worker thread
```
start_thread(
  name: "Dashboard Worker",
  task: "You are a dashboard specialist. You build and maintain the Vue dashboard.",
  memorySourceThreadId: <ORCHESTRATOR_THREAD_ID>  // share memory context
)
→ returns { threadId: <WORKER_THREAD_ID> }
```

#### Step 2 — Send a detailed task with EXPLICIT report-back instruction
```
send_message_to_thread(
  threadId: <WORKER_THREAD_ID>,
  message: "Task: Rewrite the dashboard settings page using React.
  Acceptance criteria:
  - Settings load from /api/settings
  - Form validates input
  - Save button persists changes
  
  ⚠️ IMPORTANT: When complete, report your results back to thread <ORCHESTRATOR_THREAD_ID> using:
  send_message_to_thread(threadId=<ORCHESTRATOR_THREAD_ID>, message='...')"
)
```

**CRITICAL**: The task message MUST include the orchestrator's thread ID so the worker knows where to send results.

#### Step 3 — Wait for results (do NOT duplicate the work)
```
remote_copilot_wait_for_instructions(threadId: <ORCHESTRATOR_THREAD_ID>)
```
The orchestrator parks here. It does NOT start doing the work itself. The worker will execute the task and send results back via `send_message_to_thread`.

#### Step 4 — Process results when they arrive
Results arrive as a message in `wait_for_instructions`. Review, approve, or request changes by sending another message to the worker.

### Rules

- **NEVER** duplicate work after delegating. If you sent it to a worker, wait for the response.
- **ALWAYS** include the orchestrator thread ID in the task message so the worker can report back.
- **ALWAYS** include clear acceptance criteria in the task message.
- **ALWAYS** use `wait_for_instructions` after sending the task — this is what makes you an orchestrator, not a doer.
- Worker threads build domain-specific memory over time — reuse the same thread for the same domain.
- The orchestrator stays clean for high-level decisions and operator interaction.

### Anti-Patterns

- ❌ Sending a task then immediately doing the work yourself
- ❌ Creating a worker thread AND running a subagent for the same task
- ❌ Forgetting to include the orchestrator thread ID in the task message
- ❌ Sending tasks without acceptance criteria
- ❌ Creating a new thread for every task instead of reusing domain threads
- ❌ Reading worker results and re-doing the work instead of applying them
