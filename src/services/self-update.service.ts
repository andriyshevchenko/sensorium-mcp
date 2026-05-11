/**
 * Self-update service — polls npm registry for new versions of sensorium-mcp
 * and performs a graceful self-spawn update when a newer version is found.
 *
 * Entry point: startSelfUpdatePoller({ pkgVersion, httpPort })
 * Call once after the HTTP server is listening (HTTP mode only).
 *
 * Environment variables:
 *   SELF_UPDATE_ENABLED        "false" to disable (default: enabled)
 *   SELF_UPDATE_POLL_INTERVAL_MS  Registry check interval (default: 60000)
 *   SELF_UPDATE_MIN_UPTIME_MS  Min uptime before first update (default: 600000)
 *   SELF_UPDATE_GRACE_MS       Grace period for agents to observe flag (default: 30000)
 *   MCP_START_COMMAND          Replacement spawn command (default: npx -y sensorium-mcp@latest --prefer-online)
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import { emitMaintenanceSignal } from "./maintenance-signal.js";
import { writeReconnectSnapshot } from "./reconnect-snapshot.service.js";
import { getActiveThreadIds } from "./process.service.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const DATA_DIR = join(homedir(), ".remote-copilot-mcp");
const FLAG_PATH = join(DATA_DIR, "maintenance.flag");

let updateInProgress = false;
let currentVersion = "";
let configuredHttpPort = 0;
let beforeSpawnHook: (() => Promise<void> | void) | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}



/**
 * Send a best-effort Telegram message to the operator chat.
 * Uses the TELEGRAM_TOKEN / TELEGRAM_CHAT_ID env vars directly so this
 * service stays self-contained without importing the TelegramClient singleton.
 * Non-blocking — failure is logged and silently swallowed.
 */
async function notifyTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.warn(`[self-update] Telegram notify failed (non-fatal): ${err}`);
  }
}

/**
 * Poll the local health endpoint until the NEW process responds with the
 * expected version, or the timeout elapses.
 *
 * The version check is critical: on the off chance the old server hasn't
 * fully released the port yet, we verify the response version matches.
 */
async function waitForHealthy(port: number, targetVersion: string, timeoutMs = 180_000): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(2_000);
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (resp.ok) {
        const data = await resp.json() as { ok?: boolean; version?: string };
        if (data.version === targetVersion) return true;
        // Old server still responding — keep waiting for new one
      }
    } catch {
      // not yet alive — keep polling
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Fetch the latest published version of sensorium-mcp from the npm registry.
 * Returns null on any error so the caller can silently skip this poll cycle.
 */
export async function getRemoteVersion(): Promise<string | null> {
  try {
    const response = await fetch(
      "https://registry.npmjs.org/sensorium-mcp/latest",
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) {
      log.warn(`[self-update] Registry responded ${response.status} — skipping`);
      return null;
    }
    const data = await response.json() as { version?: string };
    if (typeof data.version !== "string") {
      log.warn("[self-update] Registry response missing .version — skipping");
      return null;
    }
    return data.version;
  } catch (err) {
    log.warn(`[self-update] Registry fetch failed: ${err}`);
    return null;
  }
}

/**
 * Full update sequence:
 *   1. Write maintenance flag  (wakes all active poll loops via fs.watch)
 *   2. Emit in-process signal  (belt-and-suspenders for loops not using fs.watch)
 *   3. Grace period            (agents observe flag and return maintenance response)
 *   4. Write reconnect snapshot
 *   5. Spawn replacement process (detached)
 *   7. Poll health endpoint until new server responds with targetVersion
 *   8a. Healthy → remove flag, exit(0)  (new server already wrote its own server.pid)
 *   8b. Unhealthy → kill child, remove flag, abort (MCP continues on current version)
 */
async function performUpdate(targetVersion: string): Promise<void> {
  updateInProgress = true;
  try {
    log.info(`[self-update] Updating v${currentVersion} -> v${targetVersion}`);

    // Best-effort Telegram notification (non-blocking)
    void notifyTelegram(`sensorium-mcp: Updating v${currentVersion} -> v${targetVersion}...`);

    // Write maintenance flag
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(FLAG_PATH, JSON.stringify({
        version: targetVersion,
        writtenAt: new Date().toISOString(),
      }));
    } catch (err) {
      log.error(`[self-update] Failed to write maintenance flag: ${err}`);
      throw err;
    }

    // Wake poll loops that are already in a wait (belt-and-suspenders)
    emitMaintenanceSignal();

    // Grace period — give agents time to observe the flag and back off
    const rawGrace = parseInt(process.env.SELF_UPDATE_GRACE_MS ?? "", 10);
    const graceMs = Number.isFinite(rawGrace) && rawGrace > 0 ? rawGrace : 30_000;
    log.info(`[self-update] Grace period: ${graceMs}ms`);
    await sleep(graceMs);

    // Write reconnect snapshot so the new instance offers lightweight reconnect
    try {
      const threadIds = getActiveThreadIds();
      if (threadIds.length > 0) {
        writeReconnectSnapshot(threadIds);
      }
    } catch (err) {
      log.warn(`[self-update] Reconnect snapshot failed (non-fatal): ${err}`);
    }

    // Close existing HTTP server to free the port for the replacement process
    if (beforeSpawnHook) {
      log.info("[self-update] Closing HTTP server to free port...");
      await beforeSpawnHook();
    }

    // Spawn the replacement process (detached so it survives our exit)
    // Pin exact version to bypass stale npx cache (EPERM prevents cache clear on Windows)
    const defaultCmd = `npx -y sensorium-mcp@${targetVersion} --prefer-online`;
    const cmd = process.env.MCP_START_COMMAND ?? defaultCmd;
    log.info(`[self-update] Spawning replacement: ${cmd}`);

    const spawnLogPath = join(DATA_DIR, "update-spawn.log");
    mkdirSync(DATA_DIR, { recursive: true });
    const logFd = openSync(spawnLogPath, "a");

    const child = spawn(cmd, [], {
      detached: true,
      shell: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    });
    closeSync(logFd);
    child.unref();

    if (child.pid == null) {
      throw new Error("Spawned child process has no PID — cannot proceed");
    }

    log.info(`[self-update] Replacement PID=${child.pid}, polling health on port ${configuredHttpPort}…`);

    const healthy = await waitForHealthy(configuredHttpPort, targetVersion);

    if (healthy) {
      // The new server writes its own server.pid on startup (index.ts) with the
      // real node PID. Do NOT overwrite here — child.pid is the transient shell
      // PID on both Windows (cmd.exe) and Unix (/bin/sh), dead by this point.

      // Remove maintenance flag — watcher MCPs unblock, new keepAlive threads start
      try { unlinkSync(FLAG_PATH); } catch { /* best-effort */ }

      log.info(`[self-update] Update to v${targetVersion} complete. Exiting.`);
      process.exit(0);
    } else {
      log.error("[self-update] New process failed to become healthy. Aborting update.");
      // On Windows with shell:true, child.pid is the transient cmd.exe shell (already dead).
      // Attempt kill anyway, then fall back to port-based kill on Windows.
      try { child.kill(); } catch { /* may already be dead */ }
      if (process.platform === "win32") {
        try {
          const { execSync } = await import("node:child_process");
          // Find and kill whatever is bound to our HTTP port
          execSync(
            `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${configuredHttpPort} ^| findstr LISTENING') do taskkill /F /PID %a`,
            { shell: "cmd.exe", stdio: "ignore", timeout: 10_000 },
          );
          log.info(`[self-update] Killed orphan process on port ${configuredHttpPort}`);
        } catch {
          log.warn(`[self-update] Could not kill orphan on port ${configuredHttpPort} — manual cleanup may be needed`);
        }
      }
      // Leave maintenance.flag intact so supervisor doesn't immediately race
      // with an orphaned spawned child that may still be starting.
      log.error("[self-update] Exiting (HTTP server closed, cannot recover). Supervisor will restart.");
      process.exit(1);
    }
  } catch (err) {
    log.error(`[self-update] Update sequence failed: ${err}`);
    try { unlinkSync(FLAG_PATH); } catch { /* best-effort */ }
  } finally {
    updateInProgress = false;
  }
}

/**
 * Run one check cycle: compare remote version to current and trigger update
 * if a newer version is available.
 */
export async function checkForUpdate(): Promise<void> {
  if (updateInProgress) return;
  updateInProgress = true;

  try {
    const rawMin = parseInt(process.env.SELF_UPDATE_MIN_UPTIME_MS ?? "", 10);
    const minUptimeMs = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 600_000;

    if (process.uptime() * 1000 < minUptimeMs) {
      log.debug(
        `[self-update] Deferring — uptime ${Math.round(process.uptime())}s < min ${minUptimeMs / 1000}s`,
      );
      return;
    }

    const remoteVersion = await getRemoteVersion();
    if (remoteVersion === null) return;

    if (remoteVersion === currentVersion) {
      log.debug(`[self-update] Up to date (v${currentVersion})`);
      return;
    }

    log.info(`[self-update] New version detected: v${remoteVersion} (current: v${currentVersion})`);
    await performUpdate(remoteVersion);
  } finally {
    updateInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Start the self-update polling loop.
 * Call once after the HTTP server is listening (HTTP mode only).
 *
 * @param config.pkgVersion  Current package version string (e.g. "3.0.30").
 * @param config.httpPort    HTTP port the server is bound to (for health polling).
 */
export function startSelfUpdatePoller(config: { pkgVersion: string; httpPort: number; onBeforeSpawn?: () => Promise<void> | void }): void {
  if (process.env.SELF_UPDATE_ENABLED === "false") {
    log.info("[self-update] Disabled via SELF_UPDATE_ENABLED=false — skipping.");
    return;
  }

  currentVersion = config.pkgVersion;
  configuredHttpPort = config.httpPort;
  if (config.onBeforeSpawn) beforeSpawnHook = config.onBeforeSpawn;

  const rawInterval = parseInt(process.env.SELF_UPDATE_POLL_INTERVAL_MS ?? "", 10);
  const interval = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 60_000;

  log.info(
    `[self-update] Poller started (current: v${currentVersion}, interval: ${interval}ms)`,
  );

  setInterval(() => { void checkForUpdate(); }, interval);
}
