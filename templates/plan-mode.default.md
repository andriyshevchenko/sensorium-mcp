---
name: Plan Mode
triggers:
  - atomic
  - plan
  - planning
  - task breakdown
  - task decomposition
replaces_orchestrator: true
---

# Inputs
- `task` (required): The task to break down into atomic steps.
- `workerAgentType` (optional): The type of worker  agent (e.g., Copilot, Claude).
When unspecified, prefer:
- openai_codex, copilot_codex for small tasks - default
- copilot_claude (Opus 4.6) for medium and large tasks

# Plan Mode Skill
1. Break down the given `task` into a sequence of atomic sub-tasks (the plan), as small as possible, optimized for parallel execution by worker agents.

2. Load delegate-and-wait skill

3. Execute the plan by delegating each sub-task to a worker thread. Wait for all sub-tasks to complete and gather results.

4. Synthesize the results into a final output