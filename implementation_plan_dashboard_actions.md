# Implementation Plan: Dashboard Thread Actions

> Created: 2026-04-21. Thread: Dashboard Work (13967)

## Overview
Two new dashboard features:
1. **Manual Start Thread** — Start any thread from the dashboard UI
2. **Memory Sync to Root** — Manually synthesize branch memory back to root thread

---

## Feature 1: Manual Start Thread

### Problem
Threads can only be started via the `start_thread` MCP tool (agent-only) or automatically by the keeper. No way to manually start from the dashboard.

### Solution
Add `POST /api/threads/:id/start` + "Start" button in the UI.

### Backend

**`src/dashboard/routes/threads.ts`** — New handler:
```ts
export function handleStartThread(args: RouteArgs, threadId: number): boolean
```
1. Look up thread in registry — 404 if not found
2. Check if already running via `isThreadRunning()` — 409 if running
3. Call `dispatchSpawn()` from `agent-spawn.service.ts` with thread config
4. Return `{ ok: true, threadId, pid }` on success

Imports needed: `dispatchSpawn` from `../../services/agent-spawn.service.js`

**`src/dashboard/routes.ts`** — New route:
```ts
const threadStartMatch = /^\/api\/threads\/(\d+)\/start$/.exec(path);
if (threadStartMatch && method === "POST") {
    return handleStartThread(args, Number.parseInt(threadStartMatch[1], 10));
}
```

**`src/dashboard/routes/types.ts`** — Verify `DashboardContext` exposes `ThreadLifecycleService` (needed by `dispatchSpawn`).

### Frontend

**`src/dashboard/vue/src/components/ThreadsTab.vue`**:
- New ref: `startingThreadId`
- New function: `startThread(thread)` — POST `/api/threads/${id}/start`
- New "Start" button (green-tinted) on all thread types, in the action bar before Archive
- Disabled when `startingThreadId` matches or thread already starting

---

## Feature 2: Memory Sync to Root

### Problem
`synthesizeGhostMemory()` only runs when branches exit. No manual trigger from dashboard.

### Solution
Add `POST /api/threads/:id/synthesize` + "Sync to Root" button on branch/worker threads.

### Backend

**`src/dashboard/routes/threads.ts`** — New handler:
```ts
export function handleSynthesizeThread(args: RouteArgs, threadId: number): boolean
```
1. Look up thread — 404 if not found
2. Validate `rootThreadId` exists — 400 if not (only branches/workers)
3. Call `synthesizeGhostMemory(db, threadId, rootThreadId, thread.name)`
4. Return `{ ok: true, threadId, rootThreadId, ...synthesisResult }`

Import: `synthesizeGhostMemory` from `../../data/memory/synthesis.js`

**`src/dashboard/routes.ts`** — New route:
```ts
const threadSynthesizeMatch = /^\/api\/threads\/(\d+)\/synthesize$/.exec(path);
if (threadSynthesizeMatch && method === "POST") {
    return handleSynthesizeThread(args, Number.parseInt(threadSynthesizeMatch[1], 10));
}
```

### Frontend

**`src/dashboard/vue/src/components/ThreadsTab.vue`**:
- New ref: `syncingThreadId`
- New function: `syncToRoot(thread)` — confirm dialog, POST `/api/threads/${id}/synthesize`, show results
- New "Sync to Root" button (cyan-tinted) on branch/worker threads only
- Shown in both standalone Branches section and Children list under expanded roots

---

## Worker Assignment

### Worker 1: Backend API Endpoints
- [ ] **1.1** Check `DashboardContext` for `ThreadLifecycleService` access, add if missing
- [ ] **1.2** Add `handleStartThread` handler in `threads.ts`
- [ ] **1.3** Add `handleSynthesizeThread` handler in `threads.ts`
- [ ] **1.4** Wire both routes in `routes.ts`
- [ ] **1.5** Verify TypeScript compiles: `npx tsc --noEmit`

### Worker 2: Frontend Dashboard UI
- [ ] **2.1** Add `startThread()` function + `startingThreadId` ref
- [ ] **2.2** Add `syncToRoot()` function + `syncingThreadId` ref
- [ ] **2.3** Add "Start" button to all thread sections (root, daily, branch, worker, children)
- [ ] **2.4** Add "Sync to Root" button to branch/worker threads
- [ ] **2.5** Rebuild Vue SPA: `cd src/dashboard/vue && npm run build`

### Code Review (after each worker)
- Expert review: dead code, duplication, error handling, type safety, security
