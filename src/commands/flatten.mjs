import { createCommand } from "../terminal.mjs";
import { extname } from "../utils/path.mjs";
import {
  object,
  optional,
  argument,
  string,
  option,
  message,
} from "@optique/core";

/**
 * @type {Record<string, string>}
 */
const EXT_TO_LANG = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".jsx": "jsx",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".json": "json",
  ".xml": "xml",
  ".svg": "xml",
  ".md": "markdown",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sh": "bash",
  ".bash": "bash",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".sql": "sql",
  ".env": "env",
};

export const flatten = createCommand({
  name: "flatten",
  parser: object({
    path: argument(string({ metavar: "PATH" }), {
      description: message`Directory or file path to flatten`,
    }),
    out: optional(
      option("--out", string({ metavar: "FILE" }), {
        description: message`Output markdown file`,
      }),
    ),
  }),
  aliases: ["fl"],
  description: "Combine files into one markdown file for LLM context",
  usage: "flatten <path> [--out <file>]",
  brief: "Combine files into one markdown file for LLM context",
  execute: async (parsed, { fs }) => {
    const cliOut = parsed.out ?? null;
    const path = parsed.path;

    let files;
    let dir = path;
    try {
      const stat = await fs.stat(path);
      if (stat.isDirectory) {
        const entries = await fs.getFilesFromDirectory(path);
        files = Object.keys(entries).sort();
      } else {
        files = [path];
        dir = path.split("/").slice(0, -1).join("/") || ".";
      }
    } catch {
      return `flatten: cannot read '${path}'`;
    }

    const folderName =
      dir === "."
        ? "project"
        : dir.split("/").filter(Boolean).pop() || "project";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const outFile = cliOut || `${dir}/${folderName}_${ts}.md`;
    const lines = [`# Project Files`, `Generated: ${ts}`, "", ""];

    for (const file of files) {
      try {
        const content = await fs.readFile(file, { encoding: "utf8" });
        let mtime = "";

        lines.push(`## File: ${file}`);
        lines.push("");

        const ext = extname(file);
        const lang = EXT_TO_LANG[ext] || "";
        lines.push("```" + lang);
        lines.push(
          typeof content === "string"
            ? content
            : new TextDecoder().decode(content),
        );
        lines.push("```");
        lines.push("");
      } catch {}
    }

    const result = lines.join("\n");

    if (outFile) {
      await fs
        .mkdir(outFile.split("/").slice(0, -1).join("/") || ".", {
          recursive: true,
        })
        .catch(() => {});
      await fs.writeFile(outFile, result);
      return `Wrote ${outFile} (${result.length} bytes)`;
    }

    return result;
  },
});
