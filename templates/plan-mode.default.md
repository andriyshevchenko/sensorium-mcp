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
- `workerAgentType` (required): The type of worker  agent (e.g., Copilot, Claude).

# Plan Mode Skill
1. Break down the given `task` into a sequence of atomic sub-tasks (the plan), as small as possible, optimized for parallel execution by worker agents.

2. Load delegate-and-wait skill

3. Execute the plan by delegating each sub-task to a worker thread. Wait for all sub-tasks to complete and gather results.

4. Synthesize the results into a final output