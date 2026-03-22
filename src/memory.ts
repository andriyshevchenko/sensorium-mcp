/**
 * Memory subsystem — barrel re-export.
 *
 * All memory functionality lives in src/data/memory/ modules.
 * This file re-exports everything so existing `import … from "./memory.js"`
 * statements continue to work unchanged.
 */

export * from "./data/memory/index.js";


