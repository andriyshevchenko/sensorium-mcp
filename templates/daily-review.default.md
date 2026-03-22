<!--
  Default daily code review template for remote-copilot-mcp.

  Copy this file to ~/.remote-copilot-mcp/templates/daily-review.md to activate.
  Use with schedule_wake_up cron tasks, e.g.:
    schedule_wake_up({ label: "daily code review", cron: "0 9 * * *",
      prompt: "<contents of this template>" })

  Supported variables (replaced at render time):
    {{TIME}}  — formatted timestamp
-->

🔍 **Daily Code Review** — {{TIME}}

Run the following checks and report the results:

1. **Architecture lint** — Run `node scripts/lint-architecture.mjs` to verify:
   - No source file exceeds 300 lines
   - No circular imports exist
   If any violations are found, list them and propose fixes.

2. **Compile check** — Run `npx tsc --noEmit` and report any type errors.

3. **Quick scan** — Skim recent git changes (`git log --oneline -10`) for anything that might need follow-up.

Report progress when done, then call wait_for_instructions.
