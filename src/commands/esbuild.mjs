import { WebFileSystem } from "../fs.mjs";
import { readJSON } from "../utils/json.mjs";
import { esbuildConfigSchema } from "../utils/schemas.mjs";
import {
    object,
    optional,
    option,
    string,
    message,
    argument,
    multiple,
    map,
    choice,
    integer,
} from "@optique/core";
import { createCommand } from "../terminal.mjs";
import { aliasPlugin, fsPlugin, getEsbuild, httpPlugin } from "../utils/esbuild.mjs";

/**
 * Convert esbuild-style --flag:value args to --flag value for optique parsing.
 * @param {string[]} args
 * @returns {string[]}
 */
function preprocessArgs(args) {
    const result = [];
    for (const arg of args) {
        const m = arg.match(/^(--[\w-]+):(.+)/);
        if (m) {
            result.push(m[1], m[2]);
        } else {
            result.push(arg);
        }
    }
    return result;
}

/**
 * Remove undefined entries from an object (CLI args not provided by user).
 * @param {Record<string, any>} obj
 * @returns {Record<string, any>}
 */
function defined(obj) {
    return Object.fromEntries(
        Object.entries(obj).filter(([_, v]) => v !== undefined),
    );
}

/**
 * Split a "key=value" string on the first `=`.
 * @param {string} s
 * @returns {[string, string]}
 */
function splitEq(s) {
    const i = s.indexOf("=");
    return [s.slice(0, i), s.slice(i + 1)];
}

// --- CLI PARSER ---

const esbuildParser = object({
    entryPoints: map(
        multiple(argument(string({ metavar: "FILES" }))),
        (v) => [...v],
    ),

    // General
    bundle: optional(option("--bundle", { description: message`Bundle all dependencies into the output files` })),
    platform: optional(
        option("--platform", choice(["browser", "node", "neutral"], { metavar: "PLATFORM" }), {
            description: message`Platform target (browser, node, neutral)`,
        }),
    ),
    tsconfig: optional(
        option("--tsconfig", string({ metavar: "FILE" }), {
            description: message`Use the tsconfig.json from this file instead of the default`,
        }),
    ),
    watch: optional(option("--watch", { description: message`Watch for changes and rebuild` })),

    // Input
    loader: map(
        multiple(option("--loader", string({ metavar: "EXT=NAME" }))),
        (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
    ),

    // Output contents
    format: optional(
        option("--format", choice(["iife", "cjs", "esm"], { metavar: "FORMAT" }), {
            description: message`Output format (iife, cjs, esm)`,
        }),
    ),
    splitting: optional(option("--splitting", { description: message`Enable code splitting` })),
    banner: map(
        multiple(option("--banner", string({ metavar: "TYPE=TEXT" }))),
        (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
    ),
    footer: map(
        multiple(option("--footer", string({ metavar: "TYPE=TEXT" }))),
        (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
    ),
    charset: optional(
        option("--charset", choice(["utf8", "ascii"], { metavar: "CHARSET" }), {
            description: message`Character set (utf8, ascii)`,
        }),
    ),
    globalName: optional(
        option("--global-name", string({ metavar: "NAME" }), {
            description: message`Global name for the IIFE format`,
        }),
    ),
    legalComments: optional(
        option("--legal-comments", choice(["none", "inline", "eof", "linked", "external"], { metavar: "MODE" }), {
            description: message`How to handle legal comments`,
        }),
    ),
    lineLimit: optional(
        option("--line-limit", integer({ metavar: "N" }), {
            description: message`Line length limit`,
        }),
    ),

    // Output location
    outdir: optional(
        option("--outdir", string({ metavar: "DIR" }), {
            description: message`Output directory`,
        }),
    ),
    outfile: optional(
        option("--outfile", string({ metavar: "FILE" }), {
            description: message`Output file (mutually exclusive with outdir)`,
        }),
    ),
    outbase: optional(
        option("--outbase", string({ metavar: "DIR" }), {
            description: message`Base directory for output paths`,
        }),
    ),
    outExtension: map(
        multiple(option("--out-extension", string({ metavar: "EXT=EXT" }))),
        (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
    ),
    entryNames: optional(
        option("--entry-names", string({ metavar: "PATTERN" }), {
            description: message`Pattern for entry point output file names`,
        }),
    ),
    chunkNames: optional(
        option("--chunk-names", string({ metavar: "PATTERN" }), {
            description: message`Pattern for chunk output file names`,
        }),
    ),
    assetNames: optional(
        option("--asset-names", string({ metavar: "PATTERN" }), {
            description: message`Pattern for asset output file names`,
        }),
    ),
    publicPath: optional(
        option("--public-path", string({ metavar: "PATH" }), {
            description: message`Public path for assets`,
        }),
    ),
    allowOverwrite: optional(
        option("--allow-overwrite", { description: message`Allow output files to overwrite input files` }),
    ),

    // Path resolution
    alias: map(
        multiple(option("--alias", string({ metavar: "FROM=TO" }))),
        (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
    ),
    conditions: map(
        multiple(option("--conditions", string({ metavar: "COND" }))),
        (arr) => [...arr],
    ),
    external: map(
        multiple(option("--external", string({ metavar: "NAME" }))),
        (arr) => [...arr],
    ),
    mainFields: optional(
        option("--main-fields", string({ metavar: "FIELDS" }), {
            description: message`Main fields to use (comma-separated)`,
        }),
    ),
    nodePaths: optional(
        option("--node-paths", string({ metavar: "PATHS" }), {
            description: message`Node paths for module resolution (comma-separated)`,
        }),
    ),
    preserveSymlinks: optional(
        option("--preserve-symlinks", { description: message`Preserve symlinks` }),
    ),
    resolveExtensions: optional(
        option("--resolve-extensions", string({ metavar: "EXTS" }), {
            description: message`Resolve extensions (comma-separated)`,
        }),
    ),
    packages: optional(
        option("--packages", choice(["external"], { metavar: "MODE" }), {
            description: message`Packages mode (external)`,
        }),
    ),
    absWorkingDir: optional(
        option("--abs-working-dir", string({ metavar: "DIR" }), {
            description: message`Absolute working directory`,
        }),
    ),

    // Transformation
    jsx: optional(
        option("--jsx", choice(["transform", "preserve", "automatic"], { metavar: "MODE" }), {
            description: message`JSX mode (transform, preserve, automatic)`,
        }),
    ),
    jsxDev: optional(option("--jsx-dev", { description: message`JSX dev mode` })),
    jsxFactory: optional(
        option("--jsx-factory", string({ metavar: "FACTORY" }), {
            description: message`JSX factory function`,
        }),
    ),
    jsxFragment: optional(
        option("--jsx-fragment", string({ metavar: "FRAGMENT" }), {
            description: message`JSX fragment function`,
        }),
    ),
    jsxImportSource: optional(
        option("--jsx-import-source", string({ metavar: "SOURCE" }), {
            description: message`JSX import source`,
        }),
    ),
    jsxSideEffects: optional(
        option("--jsx-side-effects", { description: message`JSX side effects` }),
    ),
    supported: map(
        multiple(option("--supported", string({ metavar: "FEATURE=BOOL" }))),
        (arr) => {
            const obj = /** @type {Record<string, boolean>} */ ({});
            for (const s of arr) {
                const [k, v] = splitEq(s);
                obj[k] = v === "true" ? true : v === "false" ? false : /** @type {any} */ (v);
            }
            return obj;
        },
    ),
    target: optional(
        option("--target", string({ metavar: "TARGET" }), {
            description: message`Language target (es2020, esnext, etc.)`,
        }),
    ),

    // Optimization
    define: map(
        multiple(option("--define", string({ metavar: "KEY=VALUE" }))),
        (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
    ),
    drop: map(
        multiple(option("--drop", choice(["console", "debugger"], { metavar: "WHAT" }))),
        (arr) => [...arr],
    ),
    dropLabels: map(
        multiple(option("--drop-labels", string({ metavar: "LABEL" }))),
        (arr) => [...arr],
    ),
    ignoreAnnotations: optional(
        option("--ignore-annotations", { description: message`Ignore side-effect annotations` }),
    ),
    inject: map(
        multiple(option("--inject", string({ metavar: "FILE" }))),
        (arr) => [...arr],
    ),
    keepNames: optional(option("--keep-names", { description: message`Keep original names` })),
    mangleProps: optional(
        option("--mangle-props", string({ metavar: "REGEX" }), {
            description: message`Mangle properties matching this regex`,
        }),
    ),
    minify: optional(option("--minify", { description: message`Minify output (shorthand for all minify flags)` })),
    minifyWhitespace: optional(
        option("--minify-whitespace", { description: message`Minify whitespace` }),
    ),
    minifyIdentifiers: optional(
        option("--minify-identifiers", { description: message`Minify identifiers` }),
    ),
    minifySyntax: optional(option("--minify-syntax", { description: message`Minify syntax` })),
    pure: map(
        multiple(option("--pure", string({ metavar: "FUNC" }))),
        (arr) => [...arr],
    ),
    treeShaking: optional(
        option("--tree-shaking", choice(["ignore-annotations"], { metavar: "MODE" }), {
            description: message`Tree shaking mode`,
        }),
    ),

    // Source maps
    sourcemap: optional(
        option("--sourcemap", string({ metavar: "MODE" }), {
            description: message`Sourcemap mode (inline, external, both, linked)`,
        }),
    ),
    sourceRoot: optional(
        option("--source-root", string({ metavar: "ROOT" }), {
            description: message`Source root for source maps`,
        }),
    ),
    sourcesContent: optional(
        option("--sources-content", { description: message`Include sources content in source maps` }),
    ),

    // Metadata
    metafile: optional(option("--metafile", { description: message`Generate a metadata file` })),
    analyze: optional(option("--analyze", { description: message`Print built file analysis` })),

    // Logging
    color: optional(option("--color", { description: message`Enable color in output` })),
    logLevel: optional(
        option("--log-level", choice(["verbose", "debug", "info", "warning", "error", "silent"], { metavar: "LEVEL" }), {
            description: message`Log level`,
        }),
    ),
    logLimit: optional(
        option("--log-limit", integer({ metavar: "N" }), {
            description: message`Log message limit`,
        }),
    ),
    logOverride: map(
        multiple(option("--log-override", string({ metavar: "KEY=LEVEL" }))),
        (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
    ),
});

// --- COMMAND ---

export default createCommand({
    name: "esbuild",
    parser: esbuildParser,
    aliases: ["build"],
    description: message`Bundle files using esbuild`,
    usage: message`esbuild [entry_points..] [options]`,
    brief: message`Bundle files using esbuild`,

    transformArgs: preprocessArgs,

    execute: async (parsed, terminal) => {
        const rawConfig = (await readJSON(terminal.fs, "esbuild.config.json")) || {};
        const cli = defined(parsed);
        const merged = { ...rawConfig, ...cli };
        const parsedConfig = esbuildConfigSchema.safeParse(merged);
        if (!parsedConfig.success) {
            terminal.error(`esbuild.config.json: ${parsedConfig.error.issues.map((i) => i.message).join(", ")}`);
        }
        const validated = parsedConfig.success ? parsedConfig.data : merged;

        const watchMode = validated.watch;
        const { watch: _w, ...buildOptions } = {
            ...validated,
            write: false,
            plugins: [aliasPlugin(), httpPlugin(), fsPlugin(terminal.fs)],
        };

        if (watchMode) {
            const esbuild = await getEsbuild();
            const context = await esbuild.context({ ...buildOptions, write: false, metafile: true });
            const result = await context.rebuild();
            for (const output of result.outputFiles ?? []) {
                await terminal.fs.writeFile(output.path, output.contents);
                terminal.success(`Wrote ${output.path} (${output.contents.length} bytes)`);
            }
            let filesToWatch = Object.keys(result.metafile?.inputs ?? {}).map((v) => v.split(":")[1]);
            terminal.addEventListener("fs:modified", async (e) => {
                const path = /** @type {any} */ (e).detail?.path;
                if (!path) return;
                if (filesToWatch.includes(path)) {
                    try {
                        const result = await context.rebuild();
                        filesToWatch = Object.keys(result.metafile?.inputs ?? {}).map((v) => v.split(":")[1]);
                        for (const output of result.outputFiles ?? []) {
                            await terminal.fs.writeFile(output.path, output.contents);
                            terminal.info(`Rebuilt ${output.path} (${output.contents.length} bytes)`);
                        }
                    } catch (err) {
                        terminal.error(`Rebuild failed: ${/** @type {any} */ (err).message}`);
                    }
                }
            });
            terminal.info("Watching for changes...");
        } else {
            const esbuild = await getEsbuild();
            const result = await esbuild.build({ ...buildOptions, plugins: [fsPlugin(terminal.fs)] });
            for (const output of result.outputFiles ?? []) {
                await terminal.fs.writeFile(output.path, output.contents);
                terminal.success(`Wrote ${output.path} (${output.contents.length} bytes)`);
            }
            if (result.metafile) {
                terminal.info(`Metafile: ${Object.keys(result.metafile.inputs).length} inputs, ${Object.keys(result.metafile.outputs).length} outputs`);
            }
        }
    },
});
