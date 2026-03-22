/**
 * Shared Telegram update dispatcher — thin re-export façade.
 *
 * The implementation has been decomposed into focused modules under
 * src/services/dispatcher/ (lock, broker, poller). This file preserves
 * the original import paths so existing consumers are unaffected.
 */
export * from './services/dispatcher/index.js';
