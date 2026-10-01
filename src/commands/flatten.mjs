import { createCommand, makeFsError, makeFsOp, withFsSpan } from "../services/commands.mjs";
import { Effect } from "effect";
import { extname } from "../utils/path.mjs";
import picomatch from "picomatch";
import { object, optional, argument, string, option, message, multiple } from "@optique/core";

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
const FlattenFsError = makeFsError("FlattenFsError");

/**
 * Run an fs operation against the WorkspaceFs service with a typed error.
 *
 * @template A
 * @param {string} op
 * @param {string} path
 * @param {(fs: import("../types/services.d.ts").WorkspaceFsService) => Promise<A>} run
 * @returns {Effect.Effect<A, FlattenFsError, any>}
 */
const fsOp = makeFsOp(FlattenFsError);

/** Per-command span + friendly error mapping for the registry's output. */
const withCommandSpan = withFsSpan;

export const flatten = createCommand({
    name: "flatten",
    parser: object({
        paths: multiple(argument(string({ metavar: "PATH" })), {
            description: message`One or more paths or glob patterns to flatten`,
        }),
        out: optional(
            option("--out", string({ metavar: "FILE" }), {
                description: message`Output markdown file`,
            }),
        ),
    }),
    aliases: ["fl"],
    description: message`Combine files into one markdown file for LLM context`,
    usage: message`flatten <path|glob>... [--out <file>]`,
    brief: message`Combine files into one markdown file for LLM context`,
    /**
     * Multiple paths or globs: each entry may be a plain directory/file path
     * (flattened recursively, as before) or a glob pattern (picomatch),
     * e.g. `flatten src docs` or `flatten "src/*.ts" "app/*.tsx"`.
     * @param {{ paths: string[], out?: string }} parsed
     * @param {import("../types/terminal.d.ts").Terminal} term
     * @returns {Effect.Effect<string | undefined, Error>}
     */
    executeEffect: (parsed, term) => {
        const cliOut = parsed.out ?? null;
        const paths = parsed.paths.length > 0 ? parsed.paths : ["."];
        const GLOB_CHARS = /[*?[\]{}]/;
        const dirPaths = paths.filter((p) => !GLOB_CHARS.test(p));
        const globPaths = paths.filter((p) => GLOB_CHARS.test(p));
        const scanRoots = [...new Set(
            paths.map((p) => {
                if (!GLOB_CHARS.test(p)) return p;
                return p.replace(/\/[^/]*$/, "") || ".";
            }).map((p) => (!p.includes("/") || p === "." ? "." : p)),
        )];

        return Effect.gen(function* () {
            /**
             * @type {[string, string][]}
             */
            const entries = [];
            const seen = new Set();
            for (const root of scanRoots) {
                const batch = yield* fsOp("getFilesFromDirectory", root, (fs) =>
                    fs.getFilesFromDirectory(root),
                );
                for (const entry of /** @type {[string, string][]} */ (batch)) {
                    const key = entry[0];
                    if (!seen.has(key)) {
                        seen.add(key);
                        entries.push([key, entry[1]]);
                    }
                }
            }
            const isMatch = globPaths.length > 0 ? picomatch(globPaths) : null;
            const dirAllow = dirPaths.length > 0 ? picomatch(dirPaths.map((d) => d.replace(/\/$/, ""))) : null;
            const files = entries
                .map(([file, content]) => [file.replace(/^\//, ""), content])
                .filter(([file]) => {
                    const name = file.split("/").pop() || file;
                    if (name.startsWith("#") || name.startsWith(".")) return false;
                    if (/(^|\/)node_modules\//.test(file)) return false;
                    if (cliOut && file === cliOut) return false;
                    if (dirPaths.length === 0 && globPaths.length === 0) return true;
                    let matched = false;
                    if (dirAllow && dirAllow(file)) matched = true;
                    if (!matched && isMatch) {
                        matched = isMatch(file) || isMatch(`/${file}`);
                    }
                    return matched;
                })
                .sort();

            const rootName = /** @type {string} */ (
                yield* fsOp("rootName", ".", (fs) => Promise.resolve(fs.rootName))
            );
            // Where the output goes, and the label inside the header:
            // single dir -> inside that dir; everything else -> workspace root.
            const baseDir = dirPaths.length === 1 ? dirPaths[0] : ".";
            const folderName =
                baseDir === "."
                    ? rootName
                    : (baseDir.split("/").filter(Boolean).pop() || "project");
            const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
            const outFile = cliOut || `${baseDir === "." ? "" : baseDir}/#${folderName}_${ts}.md`.replace(/^\//, "");
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
            withCommandSpan("flatten.run", { paths: paths.join(","), out: cliOut ?? "<auto>" }),
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
