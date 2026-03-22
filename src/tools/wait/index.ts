/**
 * Barrel re-export for the wait-tool subsystem.
 *
 * All wait-related modules live under src/tools/wait/.
 * External consumers should import from this barrel.
 */

export { handleWaitForInstructions, type WaitToolContext, type WaitToolExtra } from "./poll-loop.js";
