---
name: Sleep
triggers:
  - sleep
  - maintenance
  - server update
replaces_orchestrator: true
---

# Inputs
- `duration` (required): Time to sleep in seconds. Set the command timeout to this value as well.

# Sleep Skill
Call powershell's `Start-Sleep` for a {{duration}} via Desktop Commander tools. Set command timeout equal to {{duration}}. This helps you to survive server restarts.