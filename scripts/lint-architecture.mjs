#!/usr/bin/env node
/**
 * Architecture lint script — checks file size violations and circular imports.
 *
 * Usage:  node scripts/lint-architecture.mjs
 * Exit 0: no errors (warnings OK)
 * Exit 1: circular imports detected
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, relative, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "src");

const MAX_LINES = 300;
const SIZE_EXCEPTIONS = new Set(["src/tools/definitions.ts"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Recursively collect all .ts files under `dir`. */
function collectTsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Count meaningful lines (non-blank, non-comment-only). */
function countMeaningfulLines(content) {
  let count = 0;
  let inBlock = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    count++;
  }
  return count;
}

/** Extract relative import targets from a TS source string. */
function extractImports(content) {
  const imports = [];
  const re = /(?:import|export)\s.*?from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

/** Resolve a relative import specifier to an absolute .ts path. */
function resolveImport(fromFile, specifier) {
  const dir = dirname(fromFile);
  let target = resolve(dir, specifier);

  // Try exact, then .ts, then /index.ts
  const candidates = [
    target,
    target + ".ts",
    resolve(target, "index.ts"),
  ];
  for (const c of candidates) {
    try {
      const s = statSync(c);
      if (s.isFile()) return c;
    } catch { /* not found */ }
  }
  return null;
}

/** DFS cycle detection on an adjacency list. Returns array of cycle paths. */
function detectCycles(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const parent = new Map();
  const cycles = [];

  for (const node of graph.keys()) color.set(node, WHITE);

  function dfs(u) {
    color.set(u, GRAY);
    for (const v of graph.get(u) || []) {
      if (!graph.has(v)) continue; // external — skip
      if (color.get(v) === GRAY) {
        // back-edge → cycle
        const cycle = [v, u];
        let cur = u;
        while (cur !== v) {
          cur = parent.get(cur);
          if (cur === undefined) break;
          if (cur === v) break;
          cycle.push(cur);
        }
        cycle.reverse();
        cycles.push(cycle);
      } else if (color.get(v) === WHITE) {
        parent.set(v, u);
        dfs(v);
      }
    }
    color.set(u, BLACK);
  }

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) dfs(node);
  }
  return cycles;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const files = collectTsFiles(SRC);
  const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");

  console.log("=== Architecture Lint ===\n");

  // 1. File size check
  console.log(`File Size Check (max ${MAX_LINES} lines):`);
  let warnings = 0;
  let withinLimit = 0;

  for (const f of files) {
    const rp = rel(f);
    if (SIZE_EXCEPTIONS.has(rp)) { withinLimit++; continue; }
    const lines = countMeaningfulLines(readFileSync(f, "utf-8"));
    if (lines > MAX_LINES) {
      console.log(`  \u26A0 ${rp}: ${lines} lines (over by ${lines - MAX_LINES})`);
      warnings++;
    } else {
      withinLimit++;
    }
  }
  console.log(`  \u2713 ${withinLimit} files within limit`);

  // 2. Circular import check
  console.log("\nCircular Import Check:");
  const graph = new Map();

  for (const f of files) {
    const content = readFileSync(f, "utf-8");
    const deps = extractImports(content)
      .map((spec) => resolveImport(f, spec))
      .filter(Boolean);
    graph.set(f, deps);
  }

  const cycles = detectCycles(graph);
  let hasErrors = false;

  if (cycles.length === 0) {
    console.log("  \u2713 No circular imports detected");
  } else {
    hasErrors = true;
    const seen = new Set();
    for (const cycle of cycles) {
      const key = cycle.map(rel).sort().join(" -> ");
      if (seen.has(key)) continue;
      seen.add(key);
      const display = [...cycle.map(rel), rel(cycle[0])].join(" -> ");
      console.log(`  \u2717 ${display}`);
    }
  }

  // 3. Result
  const parts = [];
  if (hasErrors) parts.push("FAIL");
  else parts.push("PASS");
  if (warnings > 0) parts.push(`with ${warnings} warning${warnings > 1 ? "s" : ""}`);

  console.log(`\nResult: ${parts.join(" (")}${warnings > 0 ? ")" : ""}`);

  process.exit(hasErrors ? 1 : 0);
}

main();
