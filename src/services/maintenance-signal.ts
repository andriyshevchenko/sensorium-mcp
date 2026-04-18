/**
 * Maintenance signal — notifies active poll loops immediately when the
 * maintenance flag file is written, so they can return the maintenance
 * response before the server process is killed.
 *
 * Uses fs.watch() on the data directory to detect flag creation without
 * requiring callers to poll.  The exported emitMaintenanceSignal() is
 * available for manual/test triggering.
 */

import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";

const DATA_DIR = join(homedir(), ".remote-copilot-mcp");
const FLAG_NAME = "maintenance.flag";

const emitter = new EventEmitter();
// Many poll loops (one per active thread) may subscribe simultaneously.
emitter.setMaxListeners(500);

// Watch the data directory for maintenance.flag creation / modification.
// On Windows, fs.watch fires "rename" when files are created or deleted;
// on Linux/macOS it fires "rename" on creation and "change" on modification.
let watcher: ReturnType<typeof watch> | null = null;
try {
  watcher = watch(DATA_DIR, (_eventType, filename) => {
    if (filename === FLAG_NAME) {
      emitter.emit("maintenance");
    }
  });
} catch (err) {
  // DATA_DIR might not exist yet at module load time.  The signal simply
  // won't fire from the watcher — emitMaintenanceSignal() still works.
  log.warn(`[maintenance-signal] Could not watch ${DATA_DIR}: ${err}`);
}

/** Close the filesystem watcher (call during shutdown). */
export function closeMaintenanceWatcher(): void {
  watcher?.close();
  watcher = null;
}

/** Manually fire the maintenance signal (e.g. from tests or from code that
 *  writes the flag directly without going through the file system watcher). */
export function emitMaintenanceSignal(): void {
  emitter.emit("maintenance");
}

/**
 * Subscribe to the maintenance signal.
 * @returns An unsubscribe function — call it to remove the listener.
 */
export function onMaintenanceSignal(cb: () => void): () => void {
  emitter.on("maintenance", cb);
  return () => emitter.off("maintenance", cb);
}
