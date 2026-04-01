---
name: PhantomAuth
description: Secure browser authentication for AI agents via MCP
allowed-tools:
  - secure_fill
  - secure_type
  - secure_authenticate
  - list_vault_secrets
  - list_vault_profiles
  - redacted_snapshot
---

# PhantomAuth — Secure Browser Authentication for AI Agents

PhantomAuth is an MCP server that fills web forms with credentials from SecureVault (OS keychain). AI agents NEVER see raw credential values — only secret titles are passed. Values are resolved at runtime and injected directly into browser fields via Playwright.

## Architecture

```
AI Agent → PhantomAuth MCP → Playwright MCP (shared browser) → Browser
                ↕
          SecureVault (OS Keychain)
```

## Prerequisites

- Playwright MCP must be running with `--shared-browser-context` on port 8931
- PhantomAuth needs `PLAYWRIGHT_MCP_URL=http://localhost:8931/mcp` environment variable

## Available Tools

### `list_vault_secrets`
List all available secret titles in SecureVault. Call this first to discover what secrets are available.
- No parameters required
- Returns: list of secret titles and their types (password, token, api-key, other)

### `list_vault_profiles`
List authentication profiles and their env var → secret mappings.
- No parameters required
- Returns: profile names with their variable mappings

### `secure_fill`
Fill a single form field with a secret value. The agent specifies the secret title and CSS selector — PhantomAuth resolves the value from the vault and fills it via `document.execCommand('insertText')`.
- `secretTitle` (required): Title of the secret in vault (e.g. "NICE_EMAIL")
- `selector` (required): CSS selector of the input field (e.g. "input[name='loginfmt']", "input[name='passwd']")

### `secure_type`
Type a secret value into a form field. Same as secure_fill but uses keystroke simulation. Use when `secure_fill` doesn't trigger field validation.
- `secretTitle` (required): Title of the secret in vault
- `selector` (optional): CSS selector. If omitted, types into the focused element
- `pressEnterAfter` (optional, default false): Press Enter after typing

### `secure_authenticate`
Execute a multi-step login flow from a SecureVault profile. Each step fills one field.
- `profileName` (required): Name of the profile
- `steps` (required): Array of steps, each with:
  - `selector`: CSS selector
  - `envVar`: Environment variable name from the profile (e.g. "EMAIL", "PASSWORD")
  - `action`: "fill" or "type" (default: "fill")
  - `pressEnterAfter`: boolean (default: false)
  - `waitMs`: milliseconds to wait after this step

### `redacted_snapshot`
Take a browser snapshot with all vault secret values automatically redacted. Use this INSTEAD of Playwright's `browser_snapshot` when sensitive data like emails or passwords may be visible on screen.
- No parameters required
- Returns: accessibility tree snapshot with all vault values replaced by `[REDACTED]`

## Recommended Workflow for Web Login

1. **Navigate** to the login page using Playwright's `browser_navigate`
2. **Wait** for the page to load using Playwright's `browser_wait_for`
3. **Discover secrets**: Call `list_vault_secrets` to find available credentials
4. **Fill email/username**: Call `secure_fill` with the email secret and the email input selector
5. **Click Next/Submit**: Use Playwright's `browser_click` on the submit button
6. **Wait** for password page to load
7. **Fill password**: Call `secure_fill` with the password secret and password input selector
8. **Click Sign In**: Use Playwright's `browser_click`
9. **Handle MFA**: Wait for and handle any MFA prompts (may require user intervention)
10. **Verify**: Use `redacted_snapshot` to confirm login succeeded without exposing credentials

## Security Rules

- NEVER ask the user for passwords or credentials — always use vault secrets
- NEVER log, display, or include credential values in responses
- Use `redacted_snapshot` instead of `browser_snapshot` when credentials may be on screen
- The agent only sees secret titles, never values
- All credential handling happens server-side in PhantomAuth

## Common CSS Selectors for Login Pages

| Site | Email/Username | Password |
|------|---------------|----------|
| Microsoft/Azure/Teams | `input[name='loginfmt']` | `input[name='passwd']` |
| Google | `input[type='email']` | `input[type='password']` |
| GitHub | `input[name='login']` | `input[name='password']` |
| Generic | `input[type='email']`, `#email` | `input[type='password']`, `#password` |

## Troubleshooting

- If `secure_fill` doesn't work, try `secure_type` — some frameworks need keystroke events
- If field values aren't recognized by the page, the framework may need Enter press or blur event
- Always check the page state with `redacted_snapshot` after filling to confirm the value was accepted
