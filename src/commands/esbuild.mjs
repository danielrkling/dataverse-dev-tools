import * as z from "zod";
import { Effect } from "effect";
import { createWatchPipeline } from "../effects/watch-pipeline.mjs";
import { recordWrites } from "../effects/echo-guard.mjs";
import {
    object,
    optional,
    option,
    argument,
    string,
    message,
    multiple,
    map,
    choice,
    integer,
    or,
    flag,
    withDefault,
} from "@optique/core";
import { createCommand } from "../services/commands.mjs";
import { WorkspaceFs } from "../effects/services.mjs";
import { FsError } from "./fs.mjs";
import { aliasPlugin, fsPlugin, getEsbuildEffect, httpPlugin, BuildError, describeBuildCause } from "../utils/esbuild.mjs";
import picomatch from "picomatch";
import { dropUndefined } from "../utils/json.mjs";
import {bus} from "../services/bus.mjs"

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



export const esbuildConfigSchema = z.object({
    // Input
    entryPoints: z
        .union([z.string(), z.array(z.string())])
        .transform((v) => (typeof v === "string" ? [v] : v))
        .default(["./src/app.ts"]),
    loader: z
        .record(
            z.string(),
            z.enum(["js", "jsx", "ts", "tsx", "json", "css", "text", "binary", "base64", "dataurl", "file", "empty"]),
        )
        .optional(),

    // Output contents
    format: z.enum(["iife", "cjs", "esm"]).default("esm"),
    splitting: z.boolean().default(false),
    banner: z.object({ js: z.string().optional(), css: z.string().optional() }).optional(),
    footer: z.object({ js: z.string().optional(), css: z.string().optional() }).optional(),
    charset: z.enum(["utf8", "ascii"]).optional(),
    globalName: z.string().optional(),
    legalComments: z.enum(["none", "inline", "eof", "linked", "external"]).optional(),
    lineLimit: z.number().optional(),

    // Output location
    outdir: z.string().default("dist"),
    outfile: z.string().optional(),
    outbase: z.string().optional(),
    outExtension: z.record(z.string(), z.string()).default({ ".js": ".mjs" }),
    entryNames: z.string().optional(),
    chunkNames: z.string().optional(),
    assetNames: z.string().optional(),
    publicPath: z.string().optional(),
    write: z.boolean().optional(),
    allowOverwrite: z.boolean().optional(),

    // Path resolution
    alias: z.record(z.string(), z.string()).optional(),
    conditions: z.array(z.string()).optional(),
    external: z.array(z.string()).optional(),
    mainFields: z.array(z.string()).optional(),
    nodePaths: z.array(z.string()).optional(),
    packages: z.enum(["external"]).optional(),
    preserveSymlinks: z.boolean().optional(),
    resolveExtensions: z.array(z.string()).optional(),
    absWorkingDir: z.string().optional(),

    // Transformation
    jsx: z.enum(["transform", "preserve", "automatic"]).optional(),
    jsxDev: z.boolean().optional(),
    jsxFactory: z.string().optional(),
    jsxFragment: z.string().optional(),
    jsxImportSource: z.string().optional(),
    jsxSideEffects: z.boolean().optional(),
    supported: z.record(z.string(), z.boolean()).optional(),
    target: z.union([z.string(), z.array(z.string())]).optional(),
    tsconfig: z.string().optional(),

    // Optimization
    define: z.record(z.string(), z.string()).optional(),
    drop: z.array(z.enum(["console", "debugger"])).optional(),
    dropLabels: z.array(z.string()).optional(),
    ignoreAnnotations: z.boolean().optional(),
    inject: z.array(z.string()).optional(),
    keepNames: z.boolean().optional(),
    mangleProps: z
        .string()
        .optional()
        .transform((v) => (v ? new RegExp(v) : undefined)),
    mangleQuoted: z.boolean().optional(),
    reserveProps: z
        .string()
        .optional()
        .transform((v) => (v ? new RegExp(v) : undefined)),
    minify: z.boolean().default(false),
    minifyWhitespace: z.boolean().optional(),
    minifyIdentifiers: z.boolean().optional(),
    minifySyntax: z.boolean().optional(),
    pure: z.array(z.string()).optional(),
    treeShaking: z.boolean().optional(),

    // Source maps
    sourcemap: z.union([z.boolean(), z.enum(["inline", "external", "both"])]).default("inline"),
    sourceRoot: z.string().optional(),
    sourcesContent: z.boolean().optional(),

    // Metadata
    metafile: z.boolean().optional(),
    analyze: z.boolean().optional(),

    // General
    bundle: z.boolean().default(true),
    platform: z.enum(["browser", "node", "neutral"]).default("browser"),
    watch: z.boolean().optional(),

    // Logging
    color: z.boolean().optional(),
    logLevel: z.enum(["verbose", "debug", "info", "warning", "error", "silent"]).optional(),
    logLimit: z.number().optional(),
    // logOverride: z.record(z.string(), z.string()).optional(),
});

// --- CLI PARSER ---

/** `esbuild --init` scaffolds esbuild.config.json; anything else is a run. */
const esbuildParser = object({
    init: optional(
        option("--init", {
            description: message`Scaffold the default config file and exit`,
        }),
    ),
    entryPoints: map(
        multiple(
            argument(string({ metavar: "FILES" }), {
                description: message`Entry point files or glob patterns`,
            }),
        ),
        (v) => (v.length ? v : undefined),
    ),

    // General
    config: optional(
        option("-c", "--config", string({ metavar: "FILE" }), {
            description: message`Path to config file (default: esbuild.config.json)`,
        }),
    ),
    bundle: optional(
        option("--bundle", {
            description: message`Bundle all dependencies into the output files`,
        }),
    ),
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

    // Output contents
    format: optional(
        option("--format", choice(["iife", "cjs", "esm"], { metavar: "FORMAT" }), {
            description: message`Output format (iife, cjs, esm)`,
        }),
    ),
    splitting: optional(option("--splitting", { description: message`Enable code splitting` })),
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
        option(
            "--legal-comments",
            choice(["none", "inline", "eof", "linked", "external"], {
                metavar: "MODE",
            }),
            {
                description: message`How to handle legal comments`,
            },
        ),
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
        option("--allow-overwrite", {
            description: message`Allow output files to overwrite input files`,
        }),
    ),

    // Path resolution
    packages: optional(
        option("--packages", choice(["bundle","external"], { metavar: "MODE" }), {
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
    jsxSideEffects: optional(option("--jsx-side-effects", { description: message`JSX side effects` })),
    target: optional(
        option("--target", string({ metavar: "TARGET" }), {
            description: message`Language target (es2020, esnext, etc.)`,
        }),
    ),

    // Optimization
    drop: map(multiple(option("--drop", choice(["console", "debugger"], { metavar: "WHAT" }))), (v) =>
        v.length ? v : undefined,
    ),
    dropLabels: map(multiple(option("--drop-labels", string({ metavar: "LABEL" }))), (v) => (v.length ? v : undefined)),
    ignoreAnnotations: optional(
        option("--ignore-annotations", {
            description: message`Ignore side-effect annotations`,
        }),
    ),
    inject: map(multiple(option("--inject", string({ metavar: "FILE" }))), (v) => (v.length ? v : undefined)),
    keepNames: optional(option("--keep-names", { description: message`Keep original names` })),
    mangleProps: optional(
        option("--mangle-props", string({ metavar: "REGEX" }), {
            description: message`Mangle properties matching this regex`,
        }),
    ),
    minify: optional(
        option("--minify", {
            description: message`Minify output (shorthand for all minify flags)`,
        }),
    ),
    minifyWhitespace: optional(option("--minify-whitespace", { description: message`Minify whitespace` })),
    minifyIdentifiers: optional(
        option("--minify-identifiers", {
            description: message`Minify identifiers`,
        }),
    ),
    minifySyntax: optional(option("--minify-syntax", { description: message`Minify syntax` })),
    pure: map(multiple(option("--pure", string({ metavar: "FUNC" }))), (v) => (v.length ? v : undefined)),
    treeShaking: map(
        optional(
            option("--tree-shaking", string({ metavar: "MODE" }), {
                description: message`Tree shaking mode (true, false, or ignore-annotations)`,
            }),
        ),
        (s) => (s === "true" ? true : s === "false" ? false : s),
    ),

    // Source maps
    sourcemap: optional(
        option("--sourcemap", choice(["inline", "external", "both", "linked"], { metavar: "MODE" }), {
            description: message`Sourcemap mode (inline, external, both, linked, or bare --sourcemap for true)`,
        }),
    ),
    sourceRoot: optional(
        option("--source-root", string({ metavar: "ROOT" }), {
            description: message`Source root for source maps`,
        }),
    ),
    sourcesContent: optional(
        option("--sources-content", {
            description: message`Include sources content in source maps`,
        }),
    ),

    // Metadata
    metafile: optional(option("--metafile", { description: message`Generate a metadata file` })),
    analyze: optional(option("--analyze", { description: message`Print built file analysis` })),

    // Logging
    color: optional(option("--color", { description: message`Enable color in output` })),
    logLevel: optional(
        option(
            "--log-level",
            choice(["verbose", "debug", "info", "warning", "error", "silent"], {
                metavar: "LEVEL",
            }),
            {
                description: message`Log level`,
            },
        ),
    ),
    logLimit: optional(
        option("--log-limit", integer({ metavar: "N" }), {
            description: message`Log message limit`,
        }),
    ),
});

/**
 * `esbuild --init` scaffolds esbuild.config.json; anything else is a run.
 */

// --- COMMAND ---

/**
 * Describe a typed failure on a single line.
 * @param {{ _tag: string, op?: string, path?: string, cause?: unknown }} e
 * @returns {string}
 */
function describeError(e) {
    const where = e.path ? `${e.op} '${e.path}'` : e.op || e._tag;
    return `${where}: ${describeBuildCause(e.cause)}`;
}

/**
 * Friendly single-line error for the registry's Cause.pretty output
 * (stack stripped so the terminal shows one line, not a trace).
 * @param {string} message
 * @returns {Error}
 */
function friendlyError(message) {
    const e = new Error(message);
    /** @type {any} */ (e).stack = null;
    return e;
}

/**
 * Parse JSON text as an Effect with a typed config error.
 *
 * @param {string} content
 * @param {string} configPath
 * @returns {Effect.Effect<any, FsError>}
 */
function parseJSONEffect(content, configPath) {
    return Effect.try({
        try: () => JSON.parse(content),
        catch: (cause) => FsError("parse", configPath)(cause),
    });
}

/**
 * Load and parse the config file. Missing file (no explicit --config) yields
 * `{}`; any other failure surfaces as a typed {@link FsError}.
 *
 * @param {string} configPath
 * @param {boolean} required
 * @returns {Effect.Effect<any, FsError, any>}
 */
function loadConfigEffect(configPath, required) {
    return Effect.gen(function* () {
        const fs = yield* WorkspaceFs;
        const content = yield* Effect.tryPromise({
            try: () => fs.readFile(configPath, { encoding: "utf8" }),
            catch: FsError("readFile", configPath),
        });
        return yield* parseJSONEffect(/** @type {string} */ (content), configPath);
    }).pipe(
        required
            ? Effect.mapError((e) => e)
            : Effect.catchAll(() => Effect.succeed({})),
    );
}

export default createCommand({
    name: "esbuild",
    parser: esbuildParser,
    aliases: ["build"],
    description: message`Bundle files using esbuild`,
    usage: message`esbuild init | esbuild [entry_points..] [options]`,
    brief: message`Bundle files using esbuild`,

    transformArgs: preprocessArgs,

    /**
     * @param {{ config?: string } & Record<string, any>} parsed
     * @param {import("../types/terminal.d.ts").Terminal} term
     * @returns {Effect.Effect<undefined, Error>}
     */
    timeoutSeconds: 300,
    executeEffect: (parsed, term) => {
        const configPath = parsed.config || "esbuild.config.json";

        return /** @type {Effect.Effect<undefined, Error>} */ (
            Effect.gen(function* () {
                // --- `esbuild --init`: scaffold the default config file ---
                if (parsed.init) {
                    const fs = yield* WorkspaceFs;
                    if (yield* Effect.tryPromise({ try: () => fs.exists(configPath), catch: () => false })) {
                        term.error(`${configPath} already exists — remove it first if you want to re-scaffold.`);
                        return undefined;
                    }
                    const scaffold = {
                        entryPoints: ["src/**/*.{js,mjs}", "index.js"],
                        outdir: "dist",
                        bundle: true,
                        format: "esm",
                        target: "es2022",
                        sourcemap: "inline",
                        minify: false,
                    };
                    yield* Effect.tryPromise({
                        try: () => fs.writeFile(configPath, `${JSON.stringify(scaffold, null, 2)}\n`, "utf8"),
                        catch: FsError("writeFile", configPath),
                    });
                    term.success(`Wrote ${configPath} — edit entryPoints/outdir to match your project.`);
                    return undefined;
                }

                // --- config loading + validation (early returns keep the
                // old behaviour: friendly terminal error, no crash) ---
                const required = Boolean(parsed.config);
                const rawConfigResult = yield* Effect.either(loadConfigEffect(configPath, required));
                if (rawConfigResult._tag === "Left") {
                    if (required) {
                        term.error(`${configPath}: ${describeError(rawConfigResult.left)}`);
                        return undefined;
                    }
                }
                const rawConfig =
                    rawConfigResult._tag === "Right" ? rawConfigResult.right : {};

                const configResult = esbuildConfigSchema.safeParse(rawConfig);
                if (!configResult.success) {
                    term.error(`${configPath}: ${configResult.error.issues.map((i) => i.message).join(", ")}`);
                    return undefined;
                }
                const validatedConfig = configResult.data;

                const { config: _, ...cliFields } = parsed;
                const mergedResult = esbuildConfigSchema.safeParse({
                    ...validatedConfig,
                    ...dropUndefined(cliFields),
                });
                if (!mergedResult.success) {
                    term.error(`Config merge: ${mergedResult.error.issues.map((i) => i.message).join(", ")}`);
                    return undefined;
                }
                const merged = mergedResult.data;

                const watchMode = merged.watch;
                const { watch: _w, entryPoints: epPatterns, ...rest } = merged;

                // --- entry point resolution ---
                const fs = yield* WorkspaceFs;
                const isMatch = picomatch((/** @type {string[]} */ (epPatterns)).map((p) => p.replace(/^\.\//, "")));
                const matched = yield* Effect.tryPromise({
                    try: () => fs.getFilesFromDirectory("", isMatch),
                    catch: FsError("getFilesFromDirectory", "."),
                });
                const resolvedEntryPoints =
                    matched.length > 0
                        ? matched.map((/** @type {[string, string]} */ [p]) => `/${p}`)
                        : epPatterns.map((/** @type {string} */ p) => (p.startsWith("/") ? p : `/${p}`));

                const buildOptions = {
                    ...rest,
                    entryPoints: resolvedEntryPoints,
                    write: false,
                    plugins: [aliasPlugin(), httpPlugin(), fsPlugin(fs)],
                };

                /**
                 * Write build outputs — serialized (concurrency 1) so output
                 * order matches esbuild's and echoes are recorded per file.
                 * @param {import('esbuild-wasm').BuildResult} result
                 * @returns {Effect.Effect<void, FsError>}
                 */
                const writeOutputs = (result) =>
                    Effect.forEach(
                        result.outputFiles ?? [],
                        (/** @type {import('esbuild-wasm').OutputFile} */ output) =>
                            Effect.tryPromise({
                                try: () => fs.writeFile(output.path, output.contents),
                                catch: FsError("writeFile", output.path),
                            }).pipe(
                                Effect.tap(() =>
                                    Effect.sync(() =>
                                        term.success(`Wrote ${output.path} (${output.contents.length} bytes)`),
                                    ),
                                ),
                            ),
                        { concurrency: 1 },
                    ).pipe(Effect.asVoid);

                if (watchMode) {
                    const esb = yield* getEsbuildEffect;
                    const { analyze, ...watchOptions } = buildOptions;
                    const context = yield* Effect.tryPromise({
                        try: () => esb.context({ ...watchOptions, write: false, metafile: true }),
                        catch: BuildError("context"),
                    });

                    let filesToWatch = /** @type {string[]} */ ([]);

                    /**
                     * Rebuild + write outputs as an Effect. Serialized and
                     * debounced by the watch pipeline, so concurrent
                     * `fs:changed` bursts never cause overlapping rebuilds.
                     * @param {{ path: string, type: string }} e
                     */
                    const rebuildEffect = (e) =>
                        Effect.gen(function* () {
                            yield* Effect.logDebug(`rebuild triggered by ${e.type} ${e.path}`);
                            const result = yield* Effect.tryPromise({
                                try: () => context.rebuild(),
                                catch: BuildError("rebuild"),
                            });
                            filesToWatch = Object.keys(result.metafile?.inputs ?? {}).map((v) => v.split(":")[1]);
                            yield* writeOutputs(result);
                            recordWrites((result.outputFiles ?? []).map((o) => o.path));
                            yield* Effect.logInfo(
                                `Rebuilt ${result.outputFiles?.length ?? 0} output file(s) in response to ${e.path}`,
                            );
                        }).pipe(
                            Effect.withSpan("esbuild.rebuild", { attributes: { trigger: e.path } }),
                            Effect.withLogSpan("esbuild.rebuild"),
                        );

                    // Initial rebuild under the dev span.
                    const result = yield* Effect.tryPromise({
                        try: () => context.rebuild(),
                        catch: BuildError("rebuild"),
                    });
                    filesToWatch = Object.keys(result.metafile?.inputs ?? {}).map((v) => v.split(":")[1]);
                    yield* writeOutputs(result).pipe(
                        Effect.withSpan("esbuild.dev", { attributes: { mode: "watch" } }),
                        Effect.withLogSpan("esbuild.dev"),
                        Effect.tap(() => Effect.sync(() => recordWrites((result.outputFiles ?? []).map((o) => o.path)))),
                    );

                    const pipeline = createWatchPipeline({
                        name: "esbuild-watch",
                        debounceMs: 200,
                        match: (path) => filesToWatch.includes(path),
                        handler: rebuildEffect,
                        term,
                    });

                    const unsub = bus.on("fs:changed", (/** @type {CustomEvent} */ e) => {
                        pipeline.push(/** @type {any} */ (e).detail);
                    });
                    const stopBtn = document.createElement("button");
                    stopBtn.textContent = "⏹ stop watching";
                    stopBtn.addEventListener("click", () => {
                        context.dispose();
                        unsub();
                        pipeline.stop();
                        stopBtn.remove();
                    });
                    term.log(stopBtn);
                    return undefined;
                } else {
                    const esb = yield* getEsbuildEffect;
                    const { analyze, ..._buildOptions } = buildOptions;
                    const result = yield* Effect.tryPromise({
                        try: () => esb.build(_buildOptions),
                        catch: BuildError("build"),
                    });
                    yield* writeOutputs(result).pipe(
                        Effect.withSpan("esbuild.build", {
                            attributes: { entries: String(resolvedEntryPoints.length) },
                        }),
                        Effect.withLogSpan("esbuild.build"),
                    );
                    recordWrites((result.outputFiles ?? []).map((o) => o.path));
                    if (result.metafile) {
                        term.info(
                            `Metafile: ${Object.keys(result.metafile.inputs).length} inputs, ${Object.keys(result.metafile.outputs).length} outputs`,
                        );
                    }
                    return undefined;
                }
            }).pipe(
                // Map typed failures to a single friendly Error line for the
                // registry's Cause.pretty output.
                Effect.mapError((/** @type {any} */ e) =>
                    friendlyError(e instanceof Error ? e.message : describeError(e)),
                ),
            )
        );
    },
});
