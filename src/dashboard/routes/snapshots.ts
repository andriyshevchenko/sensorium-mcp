/**
 * Dashboard API — snapshot CRUD route handlers.
 *
 * Snapshots live in ~/.remote-copilot-mcp/snapshots/
 *   <name>.zip      ← zipped data files
 *   <name>.json     ← manifest (mcpVersion, createdAt, description)
 *
 * Zipping uses PowerShell Compress-Archive (Windows pragmatic solution —
 * no zip library is available in dependencies).
 */

import { homedir } from "node:os";
import { join, basename } from "node:path";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readBody, safeParseJSON, type RouteHandler } from "./types.js";
import { config } from "../../config.js";
import { errorMessage } from "../../utils.js";

const execAsync = promisify(exec);

const DATA_DIR = join(homedir(), ".remote-copilot-mcp");
const SNAPSHOTS_DIR = join(DATA_DIR, "snapshots");

/** Items to include (relative to DATA_DIR). Directories included recursively. */
const SNAPSHOT_ITEMS = ["memory.db", "settings.json", "install.config.json", "templates", "schedules", "pending-tasks", "threads", "files"];

interface SnapshotManifest {
    mcpVersion: string;
    createdAt: string;
    description: string;
}

interface SnapshotInfo extends SnapshotManifest {
    name: string;
    sizeBytes: number;
}

function ensureSnapshotsDir(): void {
    if (!existsSync(SNAPSHOTS_DIR)) {
        mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
}

function listSnapshots(): SnapshotInfo[] {
    ensureSnapshotsDir();
    const results: SnapshotInfo[] = [];
    for (const f of readdirSync(SNAPSHOTS_DIR)) {
        if (!f.endsWith(".json")) continue;
        const name = f.slice(0, -5);
        const zipPath = join(SNAPSHOTS_DIR, `${name}.zip`);
        if (!existsSync(zipPath)) continue; // orphaned manifest
        try {
            const manifest = JSON.parse(
                readFileSync(join(SNAPSHOTS_DIR, f), "utf-8"),
            ) as SnapshotManifest;
            const sizeBytes = statSync(zipPath).size;
            results.push({ name, sizeBytes, ...manifest });
        } catch {
            // skip malformed manifests
        }
    }
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
}

function generateSnapshotName(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `snapshot-${date}T${time}`;
}

/** GET /api/snapshots → { snapshots: SnapshotInfo[] } */
export const handleGetSnapshots: RouteHandler = ({ json }) => {
    try {
        json({ snapshots: listSnapshots() });
    } catch (err) {
        json({ error: errorMessage(err) }, 500);
    }
    return true;
};

/** POST /api/snapshots → { description? } → create snapshot zip + manifest */
export const handlePostSnapshot: RouteHandler = ({ req, json, db }) => {
    void (async () => {
        let tempDir: string | null = null;
        let tempDbPath: string | null = null;
        try {
            ensureSnapshotsDir();
            const raw = await readBody(req);
            const body = safeParseJSON(raw) as Record<string, unknown> | null;
            const description =
                body && typeof body === "object" && typeof body.description === "string"
                    ? body.description.trim()
                    : "";

            const name = generateSnapshotName();
            const zipPath = join(SNAPSHOTS_DIR, `${name}.zip`);
            const manifestPath = join(SNAPSHOTS_DIR, `${name}.json`);

            // Back up memory.db via better-sqlite3's backup API to avoid WAL lock.
            // Place in a unique temp dir so filename stays "memory.db" for correct
            // zip entry naming, and concurrent snapshots don't collide.
            const liveDbPath = join(DATA_DIR, "memory.db");
            if (existsSync(liveDbPath)) {
                tempDir = join(SNAPSHOTS_DIR, `_tmp_${name}`);
                mkdirSync(tempDir, { recursive: true });
                tempDbPath = join(tempDir, "memory.db");
                await db.backup(tempDbPath);
            }

            // Collect items that actually exist (use temp db copy instead of live memory.db)
            const items = SNAPSHOT_ITEMS
                .map((item) => {
                    if (item === "memory.db") return tempDbPath ?? join(DATA_DIR, item);
                    return join(DATA_DIR, item);
                })
                .filter((p) => existsSync(p));

            if (items.length === 0) {
                json({ error: "No data files found to snapshot" }, 400);
                return;
            }

            // PowerShell Compress-Archive — accepts array of literal paths
            const pathList = items
                .map((p) => `'${p.replace(/'/g, "''")}'`)
                .join(",");
            const dest = zipPath.replace(/'/g, "''");
            const cmd = `powershell.exe -NoProfile -Command "Compress-Archive -LiteralPath ${pathList} -DestinationPath '${dest}' -Force"`;
            await execAsync(cmd);

            // Write manifest
            const manifest: SnapshotManifest = {
                mcpVersion: config.PKG_VERSION,
                createdAt: new Date().toISOString(),
                description,
            };
            writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

            const sizeBytes = statSync(zipPath).size;
            json({ ok: true, snapshot: { name, sizeBytes, ...manifest } });
        } catch (err) {
            json({ error: errorMessage(err) }, 500);
        } finally {
            if (tempDir !== null) {
                try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
            }
        }
    })();
    return true;
};

/** DELETE /api/snapshots/:name → remove zip + manifest */
export function handleDeleteSnapshot(
    { json }: Parameters<RouteHandler>[0],
    name: string,
): boolean {
    try {
        // Path traversal protection: name must equal its basename and contain no separators
        const safe = basename(decodeURIComponent(name));
        if (safe !== decodeURIComponent(name) || !/^[\w-]+$/.test(safe)) {
            json({ error: "Invalid snapshot name" }, 400);
            return true;
        }
        const zipPath = join(SNAPSHOTS_DIR, `${safe}.zip`);
        const manifestPath = join(SNAPSHOTS_DIR, `${safe}.json`);
        if (!existsSync(zipPath) && !existsSync(manifestPath)) {
            json({ error: "Snapshot not found" }, 404);
            return true;
        }
        if (existsSync(zipPath)) unlinkSync(zipPath);
        if (existsSync(manifestPath)) unlinkSync(manifestPath);
        json({ ok: true });
    } catch (err) {
        json({ error: errorMessage(err) }, 500);
    }
    return true;
}
