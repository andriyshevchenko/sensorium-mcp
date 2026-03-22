/**
 * Dashboard — re-export shim.
 *
 * The actual implementation lives in:
 *   - dashboard/routes.ts  — API route handlers + SPA serving
 *   - dashboard/presets.ts — Drive template preset definitions & loading
 */
export * from './dashboard/routes.js';
export * from './dashboard/presets.js';