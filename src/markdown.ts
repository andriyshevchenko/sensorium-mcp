/**
 * Telegram MarkdownV2 conversion utilities.
 *
 * Converts standard Markdown to Telegram MarkdownV2, working around
 * several telegramify-markdown limitations.
 */

import { createRequire } from "node:module";

const esmRequire = createRequire(import.meta.url);
const telegramifyMarkdown = esmRequire("telegramify-markdown") as (
  markdown: string,
  unsupportedTagsStrategy?: "escape" | "remove",
) => string;

/**
 * Convert standard Markdown to Telegram MarkdownV2.
 *
 * Works around several telegramify-markdown limitations:
 *   1. Fenced code blocks are emitted as single-backtick inline code instead
 *      of triple-backtick blocks → pre-extract, re-insert after conversion.
 *   2. Markdown tables contain `|` which is a MarkdownV2 reserved character;
 *      telegramify-markdown does not handle tables → pre-extract and wrap in
 *      a plain code block so the table layout is preserved.
 *   3. Blockquotes with 'escape' strategy produce double-escaped characters
 *      (e.g. `\\.` instead of `\.`) → pre-convert `> text` to `▎ text`
 *      (a common Telegram convention) so the library never sees blockquotes.
 */
export function convertMarkdown(markdown: string): string {
  const blocks: Array<{ lang: string; code: string }> = [];
  const placeholder = (i: number) => `CODEBLOCKPLACEHOLDER${i}END`;

  // 1. Extract fenced code blocks (``` ... ```).
  let preprocessed = markdown.replace(
    /^```(\w*)\n([\s\S]*?)\n?```\s*$/gm,
    (_match, lang: string, code: string) => {
      blocks.push({ lang, code });
      return placeholder(blocks.length - 1);
    },
  );

  // 2. Extract Markdown tables (consecutive lines starting with `|`) and
  //    convert them to list format for better Telegram readability.
  const tableLists: string[] = [];
  const tablePlaceholder = (i: number) => `TABLEPLACEHOLDER${i}END`;
  preprocessed = preprocessed.replace(
    /^(\|.+\|)\n(\|[-| :]+\|\n)((?:\|.*\n?)*)/gm,
    (_match, firstRow: string, _sepRow: string, rest: string) => {
      const headers = firstRow.split("|").map((s: string) => s.trim()).filter(Boolean);
      const dataRows = rest.trimEnd().split("\n").filter((line: string) => line.trim().length > 0);
      const listLines: string[] = [];
      for (const row of dataRows) {
        const cells = row.split("|").map((s: string) => s.trim()).filter(Boolean);
        if (cells.length > 0) {
          const parts: string[] = [];
          for (let j = 0; j < cells.length; j++) {
            if (j === 0) {
              parts.push(cells[j]);
            } else if (j < headers.length) {
              parts.push(`${headers[j]}: ${cells[j]}`);
            } else {
              parts.push(cells[j]);
            }
          }
          listLines.push(`• ${parts.join(" — ")}`);
        }
      }
      tableLists.push(listLines.join("\n"));
      return tablePlaceholder(tableLists.length - 1) + "\n";
    },
  );

  // 3. Convert Markdown blockquotes to ▎ prefix lines.
  preprocessed = preprocessed.replace(/^>\s?(.*)$/gm, "▎ $1");

  // 4. Convert the rest with telegramify-markdown.
  let converted = telegramifyMarkdown(preprocessed, "escape");

  // 5. Re-insert code blocks in MarkdownV2 format.
  converted = converted.replace(
    /CODEBLOCKPLACEHOLDER(\d+)END/g,
    (_m, idx: string) => {
      const { lang, code } = blocks[parseInt(idx, 10)];
      const escaped = code.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
      return `\`\`\`${lang}\n${escaped}\n\`\`\``;
    },
  );

  // 6. Re-insert tables (now converted to lists) with MarkdownV2 escaping.
  converted = converted.replace(
    /TABLEPLACEHOLDER(\d+)END/g,
    (_m, idx: string) => {
      const list = tableLists[parseInt(idx, 10)];
      return list
        .replace(/([_*\[\]()~`>#+=\-{}.!|\\])/g, "\\$1");
    },
  );

  return converted;
}

/**
 * Split a message into chunks that fit Telegram's 4096-char limit.
 * Prefers splitting at line boundaries.
 */
export function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}
