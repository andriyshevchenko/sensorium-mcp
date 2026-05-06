# Archived Threads Viewer — Implementation Plan

## Goal
Add a dashboard tab to browse, summarize, and unarchive archived threads.

## Data Model Changes

### Migration 26 — `thread_registry` columns
| Column | Type | Purpose |
|--------|------|---------|
| `archived_at` | TEXT (ISO) | Timestamp when thread was archived; NULL for active |
| `summary` | TEXT | AI-generated 1–2 sentence overview; NULL until generated |

Both are nullable add-columns — no table rebuild needed.

### `archiveThread()` update
Set `archived_at = datetime('now')` alongside `status = 'archived'`.

### `unarchiveThread()`
Set `status = 'active'`, clear `archived_at`.

---

## Backend — New Endpoints

### `GET /api/threads/archived`
- Returns all threads with `status = 'archived'`, ordered by `archived_at DESC`.
- Passes through `enrichThreadNames()` (same as active threads).

### `POST /api/threads/:threadId/unarchive`
- Validates thread exists and is archived.
- Calls `unarchiveThread(db, threadId)`.
- Returns updated thread.

### `POST /api/threads/:threadId/summary`
- Fetches last 30 episodes for the thread.
- Calls OpenAI `chatCompletion` (gpt-4o-mini, temp 0.3, 150 tokens).
- Stores result in `summary` column.
- Idempotent — re-calling regenerates.

---

## Frontend — `ArchivedThreadsTab.vue`

### Data flow
- `onMounted` → `GET /api/threads/archived` → `threads[]`
- Type filter computed from `threads[]`, no extra API call.

### UI elements
| Element | Detail |
|---------|--------|
| Header card | Thread count, auto-purge notice, refresh button |
| Filter pills | All / Root / Branch / Daily / Worker with counts |
| Thread cards | Type badge, name, thread ID, relative created/archived timestamps, client, summary text |
| Actions | Generate/regenerate summary button, Unarchive button |

### Interactions
- **Unarchive**: confirm dialog → `POST /api/threads/:id/unarchive` → reload list.
- **Generate summary**: `POST /api/threads/:id/summary` → update local thread entry (no full reload).
- **Filter**: client-side computed property, instant.

---

## File Touchpoints

| File | Change |
|------|--------|
| `src/data/memory/migration-runner.ts` | Migration 26 (add columns), bump `SCHEMA_VERSION` to 26 |
| `src/data/memory/schema-ddl.ts` | Add `archived_at`, `summary` to DDL |
| `src/data/memory/thread-registry.ts` | Add fields to type + rowMapper, `getArchivedThreads()`, `unarchiveThread()`, `updateThreadSummary()`, update `archiveThread()` |
| `src/dashboard/routes/threads.ts` | `handleGetArchivedThreads`, `handleUnarchiveThread`, `handleGenerateSummary` |
| `src/dashboard/routes.ts` | Import new handlers, add to route table + dynamic routes |
| `src/dashboard/vue/src/types.ts` | Add `archivedAt`, `summary` to `ThreadEntry` |
| `src/dashboard/vue/src/App.vue` | Import + register `ArchivedThreadsTab` |
| `src/dashboard/vue/src/components/ArchivedThreadsTab.vue` | New component |

---

## Design Decisions

1. **Separate tab vs. section in Threads tab** — Separate tab keeps the Threads tab focused on active management. Archived threads are a read-mostly view with different actions (unarchive vs. start/configure).

2. **Summary on-demand vs. at-archive-time** — On-demand avoids blocking the archive action and handles threads archived before this feature existed. Users can generate summaries selectively.

3. **No hard delete from UI** — Archived threads auto-purge after 180 days via the existing daily job. No need for a manual delete button.

4. **Client-side filtering** — Archived thread counts are typically small (< 100). No need for server-side pagination or filtering.

5. **Relative timestamps** — "3d ago" / "2mo ago" is more useful than absolute dates for quick scanning. Absolute date shown on hover via `title` attribute.
