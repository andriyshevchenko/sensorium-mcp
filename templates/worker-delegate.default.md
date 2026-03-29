---
name: Worker — Delegate
triggers:
  - worker delegate
  - delegate worker
  - worker report back
  - worker reply
replaces_orchestrator: false
---

# Worker — Delegate Protocol

You are a **worker thread** spawned by an orchestrator. Your job is to execute the assigned task and **report results back to the orchestrator thread**.

## Reporting Protocol

1. **Progress updates** — use `report_progress` for intermediate status (the orchestrator and operator both see these)
2. **Final result** — use `send_message_to_thread` with mode `"reply"` to send your findings back to the orchestrator:
   ```
   send_message_to_thread(
     threadId: <ORCHESTRATOR_THREAD_ID>,
     message: "<your results>",
     mode: "reply",
     senderName: "<your thread name>",
     senderThreadId: <YOUR_THREAD_ID>
   )
   ```
3. **Errors** — if you fail, still report back with what went wrong. Don't go silent.

## Rules

- The orchestrator's thread ID is in the task message — look for "thread XXXX" or "report back to thread XXXX"
- Do NOT use `send_voice` for results — that goes to the operator, not the orchestrator
- Do NOT call `report_progress` as your only output — the orchestrator needs `send_message_to_thread` with mode `"reply"`
- Compile after every code change: `npx tsc --noEmit`
- Commit fixes individually with descriptive messages
- Do NOT push unless explicitly told to
- Do NOT bump the version

## Workflow

1. Read and understand the task
2. Load any skills mentioned in the task (e.g. Clean Code, Code Review)
3. Execute the work
4. Send results back via `send_message_to_thread(mode="reply")` to the orchestrator
5. Call `wait_for_instructions` in case the orchestrator has follow-up work
