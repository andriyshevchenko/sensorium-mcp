import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const telegramifyMarkdown = _require("telegramify-markdown");

function convertMarkdown(markdown) {
  const blocks = [];
  const ph = (i) => `CODEBLOCKPLACEHOLDER${i}END`;

  let preprocessed = markdown.replace(
    /^```(\w*)\n([\s\S]*?)\n?```\s*$/gm,
    (_, lang, code) => {
      blocks.push({ lang, code });
      return ph(blocks.length - 1);
    },
  );

  preprocessed = preprocessed.replace(/^>\s?(.*)$/gm, "▎ $1");

  let converted = telegramifyMarkdown(preprocessed, "escape");

  converted = converted.replace(/CODEBLOCKPLACEHOLDER(\d+)END/g, (_m, idx) => {
    const { lang, code } = blocks[parseInt(idx, 10)];
    const escaped = code.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
    return `\`\`\`${lang}\n${escaped}\n\`\`\``;
  });

  return converted;
}

const input = `# Session Started

Hello! Remote Copilot is ready.

## Formatting test

**Bold**, _italic_, and ~~strikethrough~~.

### Code block

\`\`\`javascript
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

### List

- Item one
- Item two
- Item three

> All formatting should now render correctly.`;

const result = convertMarkdown(input);
console.log("OUTPUT:");
console.log(result);
