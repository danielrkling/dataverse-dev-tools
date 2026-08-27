import { createCommand } from "../services/commands.mjs";
import { extname } from "../utils/path.mjs";
import { object, optional, argument, string, option, message } from "@optique/core";

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
    description: message`Combine files into one markdown file for LLM context`,
    usage: message`flatten <path> [--out <file>]`,
    brief: message`Combine files into one markdown file for LLM context`,
    execute: async (parsed, term) => {
        const { fs } = term;
        const cliOut = parsed.out ?? null;
        const path = parsed.path;

        let dir = path;

        const entries = await fs.getFilesFromDirectory(path);
        const files = entries.sort();

        const folderName = dir === "." ? "project" : dir.split("/").filter(Boolean).pop() || "project";
        const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
        const outFile = cliOut || `${dir}/#${folderName}_${ts}.md`;
        const lines = [`# Project Files`, `Generated: ${ts}`, "", ""];

        for (const [file, content] of files) {
            try {
                lines.push(`## ${file}`);
                lines.push("");

                const ext = extname(file);
                const lang = EXT_TO_LANG[ext] || "";
                lines.push("```" + lang);
                lines.push(content);
                lines.push("```");
                lines.push("");
            } catch {}
        }

        const result = lines.join("\n");

        if (outFile) {
            await fs.writeFile(outFile, result);
            term.log(`Wrote ${outFile} (${result.length} bytes)`);
        }
    },
});

export const templateCommand = createCommand({
    name: "template",
    parser: object({
        input: argument(string({ metavar: "INPUT" }), {
            description: message`Directory or file path to flatten`,
        }),
        output: argument(string({ metavar: "OUTPUT" }), {
            description: message`Directory or file path to flatten`,
        }),
    }),
    aliases:["inject"],
    description: message`Inject files via template syntax {{script.js}}`,
    usage: message`template <input> <output>`,
    brief: message`Inject files via template syntax {{script.js}}`,
    execute: async (parsed, term) => {
        const { fs } = term;

        const regex = /\{\{(.+?)\}\}/g;
        const input = await fs.readFile(parsed.input, "utf8");
        const matches = [...input.matchAll(regex)]
        if (!matches || matches.length===0) {
            await fs.writeFile(parsed.output, input);
            term.log(`Wrote ${parsed.output} (${input.length} bytes)`);
            return;
        }

        const replacements = await Promise.all(matches.map(async (match) => [match[0], await fs.readFile(match[1].trim(), "utf8")]));

        let result = input;
        for (const [placeholder, value] of replacements) {
            result = result.replace(placeholder, value);
        }

        await fs.writeFile(parsed.output, result);
        term.log(`Wrote ${parsed.output} (${result.length} bytes)`);
    },
});
