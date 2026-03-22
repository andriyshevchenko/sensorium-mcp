/**
 * Template loading, caching, and rendering utilities.
 *
 * Templates live in ~/.remote-copilot-mcp/templates/{name}.md and are
 * cached in-memory with a short TTL so edits take effect quickly without
 * needing a server restart.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES_DIR } from "../config.js";

// ── Template loading & caching ────────────────────────────────────────────

const TEMPLATE_TTL_MS = 60_000; // 60-second cache TTL

interface CachedTemplate {
  content: string | null;
  loadedAt: number;
}

const templateCache = new Map<string, CachedTemplate>();

/**
 * Load a template file from ~/.remote-copilot-mcp/templates/{name}.md.
 * Returns the raw template string, or null if the file doesn't exist.
 * Results are cached in memory with a 60-second TTL.
 */
export function loadTemplate(name: string): string | null {
  const now = Date.now();
  const cached = templateCache.get(name);
  if (cached && now - cached.loadedAt < TEMPLATE_TTL_MS) {
    return cached.content;
  }

  const filePath = join(TEMPLATES_DIR, `${name}.md`);
  let content: string | null = null;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    // File doesn't exist or is unreadable — fall back to null
    content = null;
  }

  templateCache.set(name, { content, loadedAt: now });
  return content;
}

/**
 * Replace all `{{VAR}}` placeholders in a template string with the
 * corresponding values from the provided vars map.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });
}
