# Sensorium MCP

## Platform Notes (Windows)

- **Bash tool**: On Windows, Claude Code wraps commands in `bash -c '...'`. Single quotes inside the command body (heredocs, string literals) break the outer quoting and cause `unexpected EOF while looking for matching` errors. **Always use double quotes or the Write tool instead of heredocs with single-quoted strings.**
- When running PowerShell commands, use `pwsh -c "..."` or the Write tool to create files.
