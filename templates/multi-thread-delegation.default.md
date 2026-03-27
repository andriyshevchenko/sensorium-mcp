---
name: Multi-Thread Delegation
triggers:
  - delegate to thread
  - use multi-thread
  - thread delegation
  - spawn thread
  - multi thread
  - multi-thread
  - parallel threads
replaces_orchestrator: true
---

## Multi-Thread Agent Orchestration

### Overview
This skill describes how to use sensorium-mcp's inter-thread messaging for orchestrating work across multiple persistent threads. Each thread represents a specialist worker with its own memory context.

### Thread Topology
- **Manager Thread** (main): Design decisions, operator interaction, constraints, routing
- **Worker Threads** (persistent): Specialized domains — dashboard, code-review, testing, refactoring, etc.

### Core Pattern: Delegate and Wait

When you have work that should be delegated to a worker thread:

1. **Create or identify the worker thread**
   ```
   start_thread(name: "Dashboard Worker")
   → returns { threadId: <WORKER_THREAD_ID> }
   ```

2. **Send a detailed task with clear acceptance criteria**
   ```
   send_message_to_thread(
     threadId: <WORKER_THREAD_ID>,
     message: "Task: Rewrite the dashboard settings page using React.
     Acceptance criteria:
     - Settings load from /api/settings
     - Form validates input
     - Save button persists changes
     When complete, send results back to thread <MANAGER_THREAD_ID>."
   )
   ```

3. **Wait for results — do NOT duplicate the work**
   ```
   remote_copilot_wait_for_instructions(threadId: <MANAGER_THREAD_ID>)
   ```
   The worker will execute the task and send results back via send_message_to_thread.

4. **Process results when they arrive**
   Results arrive as an operator message in wait_for_instructions. Review, approve, or request changes.

### Pattern 2: Fire and Forget

For tasks that don't need a response back — the worker executes autonomously and the manager moves on.

1. **Create or identify the worker thread**
   ```
   start_thread(name: "Background Cleanup")
   → returns { threadId: <WORKER_THREAD_ID> }
   ```

2. **Send the task — no report-back needed**
   ```
   send_message_to_thread(
     threadId: <WORKER_THREAD_ID>,
     message: "Task: Clean up stale log files older than 30 days in ~/.remote-copilot-mcp/logs/.
     This is a one-shot task. Report progress to the operator via report_progress or send_voice.
     Do NOT message the sender back."
   )
   ```

3. **Continue working immediately**
   Don't call wait_for_instructions for this task. Continue with your own work.

#### When to use Fire and Forget:
- Background cleanup tasks
- Scheduled improvements that don't affect current work
- Logging, monitoring, metrics tasks
- Any task where the result doesn't gate your next step

#### When NOT to use Fire and Forget:
- Code reviews (you need the findings to act on)
- Any task where the output determines your next action
- Tasks that modify files you're also editing (conflict risk)

### Rules

- **NEVER** duplicate work with a subagent after delegating to a thread. Trust the delegation.
- **ALWAYS** include clear acceptance criteria in the task message.
- **ALWAYS** specify which thread to report back to.
- Worker threads build domain-specific memory over time — reuse the same thread for the same domain.
- The manager thread stays clean for high-level decisions and operator interaction.

### Anti-Patterns

- ❌ Creating a worker thread AND running a subagent for the same task
- ❌ Sending a task then immediately doing the work yourself
- ❌ Creating a new thread for every task instead of reusing domain threads
- ❌ Sending tasks without acceptance criteria or report-back instructions
- ❌ Reading worker results and re-doing the work instead of applying them
