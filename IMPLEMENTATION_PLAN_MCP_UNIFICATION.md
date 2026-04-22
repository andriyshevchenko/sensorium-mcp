# Unified MCP Management — Implementation Plan

## Goal
Standardize MCP server management across all agent types (Claude, Copilot, Codex).
Single canonical storage → per-agent formatters → dashboard CRUD UI.

---

## Step 1: Config Layer — `src/config.ts`

**Add** to settings.json canonical format:
```json
{ "mcpServers": { "<name>": { "type": "stdio|http", ... } } }
```

**New exports:**
```ts
interface McpServerConfig {
  type: "stdio" | "http";
  // stdio fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http fields
  url?: string;
  headers?: Record<string, string>;
}

export function getMcpServers(): Record<string, McpServerConfig>
export function setMcpServers(servers: Record<string, McpServerConfig>): void
export function addMcpServer(name: string, config: McpServerConfig): void
export function removeMcpServer(name: string): void
```

**No** other changes in this step.

**Files:** `src/config.ts`

---

## Step 2: Agent-Specific Formatters — new `src/services/mcp-config.service.ts`

Create a new service file with 3 formatters + sensorium auto-injection:

```ts
// Builds the sensorium-mcp entry from current env (stdio or http)
function buildSensoriumEntry(): McpServerEntry

// Claude: JSON file { mcpServers: { sensorium: {...}, ...userMcps } }
// Returns file path to the generated config
export function buildClaudeMcpConfig(threadId: number): string

// Copilot: same JSON format, written to copilot-home/mcp-config.json  
export function buildCopilotMcpConfig(copilotHomeDir: string): void

// Codex: returns array of `-c` CLI args
export function buildCodexMcpArgs(httpPort: number, secret: string | null): string[]
```

Each merges `getMcpServers()` + sensorium into the agent's native format.

**Files:** `src/services/mcp-config.service.ts` (new)

---

## Step 3: Spawn Integration — `src/services/agent-spawn.service.ts`

Replace the 3 scattered config generation approaches with calls to the new formatters:

### Claude (`spawnAgentProcess`)
- **Remove:** `resolveMcpConfigPath()`, `generateThreadMcpConfig()` 
- **Replace:** `const configPath = buildClaudeMcpConfig(threadId)`
- **Remove:** `mcpConfigPath` parameter — no longer needed from caller
- **Update:** `dispatchSpawn()` to stop passing mcpConfigPath

### Copilot (`spawnCopilotProcess`)
- **Remove:** `writeCopilotHomeFiles()` call's MCP part
- **Replace:** `buildCopilotMcpConfig(copilotHomeDir)`
- **Keep:** copilot-instructions.md writing (that's separate)

### Codex (`spawnCodexProcess`)
- **Remove:** inline `-c mcp_servers.*` construction
- **Replace:** `const mcpArgs = buildCodexMcpArgs(httpPort, secret); cliArgs.push(...mcpArgs)`

**Files:** `src/services/agent-spawn.service.ts`, `src/tools/shared-agent-utils.ts`

---

## Step 4: Dashboard API Routes — new `src/dashboard/routes/mcp-servers.ts`

```ts
// GET /api/mcp-servers → { servers: Record<string, McpServerConfig> }
export const handleGetMcpServers: RouteHandler

// POST /api/mcp-servers → { name, config } → add/update
export const handlePostMcpServer: RouteHandler

// DELETE /api/mcp-servers/:name → remove
// (handled as dynamic route in routes.ts)
export const handleDeleteMcpServer: RouteHandler
```

Register in `src/dashboard/routes.ts` route table.

**Files:** `src/dashboard/routes/mcp-servers.ts` (new), `src/dashboard/routes.ts`

---

## Step 5: Dashboard UI — `src/dashboard/spa.html` (or Vue component)

New "MCP Servers" tab:
- List all configured servers with type badge (stdio/http)
- Add form: name, type dropdown, command/args OR url, env/headers key-value editor
- Edit/Delete per server
- Sensorium-mcp shown as read-only "built-in" entry
- Validation: name required, type required, command required for stdio, url required for http

**Files:** `src/dashboard/spa.html` or `src/dashboard/vue/` components

---

## Step 6: Cleanup Dead Code

- **Remove** `getClaudeMcpConfigPath()` / `setClaudeMcpConfigPath()` from config.ts
- **Remove** `handleGetClaudeMcpConfig` / `handlePostClaudeMcpConfig` from settings.ts
- **Remove** corresponding route entries from routes.ts
- **Remove** `resolveMcpConfigPath()` from agent-spawn.service.ts
- **Remove** `generateThreadMcpConfig()` from agent-spawn.service.ts
- **Remove** `writeMcpConfig()` from shared-agent-utils.ts (replaced by formatter)
- **Remove** sensorium-watcher injection logic (no longer hardcoded)
- **Update** `dispatchSpawn()` signature — drop `mcpConfigPath` flow

**Files:** `src/config.ts`, `src/dashboard/routes/settings.ts`, `src/dashboard/routes.ts`, `src/services/agent-spawn.service.ts`, `src/tools/shared-agent-utils.ts`

---

## Execution Order

Each step: implement → expert code review → fix → next step.
Final: bump version, commit, push.

## Not In Scope
- Per-agent MCP selection (all agents get all MCPs)
- MCP server health checks
- Import from existing ~/.claude/settings.json
