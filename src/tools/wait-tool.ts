/**
 * Re-export shim — the poll-loop implementation has moved to tools/wait/poll-loop.ts.
 * This file is kept so existing imports from "./tools/wait-tool.js" continue to work.
 */
export { handleWaitForInstructions, type WaitToolContext, type WaitToolExtra } from "./wait/index.js";
