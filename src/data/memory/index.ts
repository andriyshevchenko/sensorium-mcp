/**
 * Barrel re-export for the memory subsystem.
 *
 * All memory modules are re-exported here so consumers can import from
 * a single path: `./data/memory/index.js`.
 *
 * Modules: utils, schema, episodes, semantic, procedures, voice-sig,
 * consolidation, reflection (causal/pattern/counterfactual insights), bootstrap.
 */

export * from './utils.js';
export * from './schema.js';
export * from './episodes.js';
export * from './semantic.js';
export * from './procedures.js';
export * from './voice-sig.js';
export * from './consolidation.js';
export * from './reflection.js';
export * from './narrative.js';
export * from './topic-shift.js';
export * from './synthesis.js';
export * from './bootstrap.js';
export * from './thread-registry.js';
