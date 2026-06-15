---
name: Markdown to PDF
triggers:
  - convert to pdf
  - markdown to pdf
  - md to pdf
  - export pdf
  - generate pdf
replaces_orchestrator: true
---

# Markdown to PDF Skill

Convert a markdown file or text to PDF and send it to the operator.

## How to Use

Use `md-to-pdf` (installed as devDependency in `C:\src\remote-copilot-mcp`) via a Node.js script:

```js
import { mdToPdf } from "md-to-pdf";
import { readFileSync } from "fs";

const pdf = await mdToPdf(
  { content: readFileSync(inputPath, "utf8") },
  {
    dest: outputPath,
    launch_options: { headless: "new", args: ["--no-sandbox"] },
    pdf_options: { format: "A4", margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" } },
  },
);
```

Output PDFs to `C:\src\remote-copilot-mcp\tmp\`.

After conversion, send via `send_file` with `filePath`.
