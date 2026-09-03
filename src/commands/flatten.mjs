import { createCommand } from "../services/commands.mjs";
import { Effect } from "effect";
import { WorkspaceFs } from "../effects/services.mjs";
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

/**
 * Typed fs failure for the flatten/template commands.
 * @typedef {{ _tag: "FlattenFsError", op: string, path: string, cause: unknown }} FlattenFsError
 */

/**
 * Error factory for {@link FlattenFsError}.
 * @param {string} op
 * @param {string} path
 * @returns {(cause: unknown) => FlattenFsError}
 */
const FlattenFsError = (op, path) => (cause) => ({
    _tag: /** @type {const} */ ("FlattenFsError"),
    op,
    path,
    cause,
});

/**
 * Run an fs operation against the WorkspaceFs service with a typed error.
 *
 * @template A
 * @param {string} op
 * @param {string} path
 * @param {(fs: import("../types/services.d.ts").WorkspaceFsService) => Promise<A>} run
 * @returns {Effect.Effect<A, FlattenFsError, any>}
 */
const fsOp = (op, path, run) =>
    Effect.flatMap(WorkspaceFs, (fs) =>
        Effect.tryPromise({
            try: () => run(fs),
            catch: FlattenFsError(op, path),
        }),
    );

/**
 * Describe a cause on a single line.
 * @param {unknown} cause
 */
const describeCause = (cause) => {
    const msg =
        cause instanceof Error
            ? cause.message
            : /** @type {any} */ (cause)?.message ?? String(cause);
    return msg || "unknown error";
};

/**
 * Per-command span + friendly error mapping for the registry's output.
 *
 * @template A
 * @param {string} name span name, e.g. "flatten.run"
 * @param {Record<string, string>} attributes
 * @returns {(effect: Effect.Effect<A, FlattenFsError, any>) => Effect.Effect<A, Error>}
 */
const withCommandSpan = (name, attributes) => (effect) =>
    /** @type {Effect.Effect<A, Error>} */ (
      effect.pipe(
        Effect.withSpan(name, { attributes }),
        Effect.withLogSpan(name),
        Effect.mapError(
          (e) => new Error(`${e.op} '${e.path}': ${describeCause(e.cause)}`),
        ),
      )
    );

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
    /**
     * @param {{ path: string, out?: string }} parsed
     * @param {import("../types/terminal.d.ts").Terminal} term
     * @returns {Effect.Effect<string | undefined, Error>}
     */
    executeEffect: (parsed, term) => {
        const cliOut = parsed.out ?? null;
        const path = parsed.path;

        const dir = path;
        return Effect.gen(function* () {
            const entries = yield* fsOp("getFilesFromDirectory", path, (fs) =>
                fs.getFilesFromDirectory(path),
            );
            const files = /** @type {[string, string][]} */ (entries).sort();

            const folderName =
                dir === "."
                    ? "project"
                    : dir.split("/").filter(Boolean).pop() || "project";
            const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
            const outFile = cliOut || `${dir}/#${folderName}_${ts}.md`;
            const lines = [`# Project Files`, `Generated: ${ts}`, "", ""];

            // Serialized formatting: plain sync work, no fs calls — order preserved.
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
                yield* fsOp("writeFile", outFile, (fs) => fs.writeFile(outFile, result));
                term.log(`Wrote ${outFile} (${result.length} bytes)`);
                return undefined;
            }
            return result;
        }).pipe(
            withCommandSpan("flatten.run", { path, out: cliOut ?? "<auto>" }),
        );
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
    aliases: ["inject"],
    description: message`Inject files via template syntax {{script.js}}`,
    usage: message`template <input> <output>`,
    brief: message`Inject files via template syntax {{script.js}}`,
    /**
     * @param {{ input: string, output: string }} parsed
     * @param {import("../types/terminal.d.ts").Terminal} term
     * @returns {Effect.Effect<void, Error>}
     */
    executeEffect: (parsed, term) => {
        const regex = /\{\{(.+?)\}\}/g;
        return Effect.gen(function* () {
            const input = yield* fsOp("readFile", parsed.input, (fs) =>
                fs.readFile(parsed.input, "utf8"),
            );
            const text = /** @type {string} */ (input);
            const matches = [...text.matchAll(regex)];
            if (!matches || matches.length === 0) {
                yield* fsOp("writeFile", parsed.output, (fs) =>
                    fs.writeFile(parsed.output, text),
                );
                term.log(`Wrote ${parsed.output} (${text.length} bytes)`);
                return;
            }

            // Concurrency 1: replacement files are read in template order so
            // fs errors surface deterministically and the first failure wins.
            const replacements = yield* Effect.forEach(
                matches,
                (match) =>
                    fsOp("readFile", match[1].trim(), (fs) =>
                        fs.readFile(match[1].trim(), "utf8"),
                    ).pipe(Effect.map((value) => /** @type {[string, string]} */ ([match[0], /** @type {string} */ (value)]))),
                { concurrency: 1 },
            );

            let result = text;
            for (const [placeholder, value] of replacements) {
                result = result.replace(placeholder, value);
            }

            yield* fsOp("writeFile", parsed.output, (fs) =>
                fs.writeFile(parsed.output, result),
            );
            term.log(`Wrote ${parsed.output} (${result.length} bytes)`);
        }).pipe(
            withCommandSpan("template.run", {
                input: parsed.input,
                output: parsed.output,
            }),
        );
    },
});
