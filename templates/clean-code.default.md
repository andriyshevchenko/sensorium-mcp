---
name: Clean Code
triggers:
  - clean code
  - write clean
  - code quality
  - quality code
replaces_orchestrator: true
---

# Clean Code Skill

Write code as if you were a Linux kernel maintainer. Apply legendary quality standards to every line.

## Standards
- **No dead code** — every export must have a consumer, every branch must be reachable
- **No duplication** — extract shared patterns, DRY without over-abstracting
- **Functions under 50 lines** — decompose ruthlessly
- **Files under 300 lines** — split when approaching the limit
- **Named constants** — no magic numbers, no inline timeouts
- **Proper error handling** — no empty catches, no swallowed errors
- **Type safety** — no `any`, no unchecked casts, validate at boundaries
- **Clear module boundaries** — no abstraction leaks, no cross-layer imports

## Process
1. Before writing, read the surrounding code to match patterns
2. Write the code
3. Review your own output against the standards above
4. Fix any violations before committing
5. If in doubt, the stricter interpretation wins
