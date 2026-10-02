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
import { createCommand, FsError, friendlyError, readJsonConfigEffect, zodIssuesMessage, attachWatchStop } from "../services/commands.mjs";
import { WorkspaceFs } from "../effects/services.mjs";
import { TerminalUi } from "../effects/terminal-ui.mjs";
import { aliasPlugin, fsPlugin, getEsbuildEffect, httpPlugin, BuildError, describeBuildCause, DEV_CONDITIONS, PROD_CONDITIONS, DEV_MAIN_FIELDS, PROD_MAIN_FIELDS } from "../utils/esbuild.mjs";
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



// The schema without its `.default()` values. Read the config file with this
// first so we can tell "the user set minify: false" apart from "the user set
// nothing" — a default applied before the mode preset is layered in would
// silently win over `--prod`. Defaults are applied exactly once, at the end.
const esbuildShape = {
    // Input
    entryPoints: z
        .union([z.string(), z.array(z.string())])
        .transform((v) => (typeof v === "string" ? [v] : v))
        .optional(),
    loader: z
        .record(
            z.string(),
            z.enum(["js", "jsx", "ts", "tsx", "json", "css", "text", "binary", "base64", "dataurl", "file", "empty"]),
        )
        .optional(),

    // Output contents
    format: z.enum(["iife", "cjs", "esm"]).optional(),
    splitting: z.boolean().optional(),
    banner: z.object({ js: z.string().optional(), css: z.string().optional() }).optional(),
    footer: z.object({ js: z.string().optional(), css: z.string().optional() }).optional(),
    charset: z.enum(["utf8", "ascii"]).optional(),
    globalName: z.string().optional(),
    legalComments: z.enum(["none", "inline", "eof", "linked", "external"]).optional(),
    lineLimit: z.number().optional(),

    // Output location
    outdir: z.string().optional(),
    outfile: z.string().optional(),
    outbase: z.string().optional(),
    outExtension: z.record(z.string(), z.string()).optional(),
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
    packages: z.enum(["bundle", "external"]).optional(),
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
    minify: z.boolean().optional(),
    minifyWhitespace: z.boolean().optional(),
    minifyIdentifiers: z.boolean().optional(),
    minifySyntax: z.boolean().optional(),
    pure: z.array(z.string()).optional(),
    treeShaking: z.boolean().optional(),

    // Source maps
    sourcemap: z.union([z.boolean(), z.enum(["inline", "external", "both", "linked"])]).optional(),
    sourceRoot: z.string().optional(),
    sourcesContent: z.boolean().optional(),

    // Metadata
    metafile: z.boolean().optional(),
    analyze: z.boolean().optional(),

    // General
    bundle: z.boolean().optional(),
    platform: z.enum(["browser", "node", "neutral"]).optional(),
    watch: z.boolean().optional(),

    // Logging
    color: z.boolean().optional(),
    logLevel: z.enum(["verbose", "debug", "info", "warning", "error", "silent"]).optional(),
    logLimit: z.number().optional(),
    // logOverride: z.record(z.string(), z.string()).optional(),
};

/**
 * Config-file shape with no defaults applied. Used to read the file and learn
 * which keys the user actually specified.
 */
export const esbuildRawSchema = z.object(esbuildShape);

/**
 * The defaults {@link esbuildRawSchema} deliberately leaves out. Applied once,
 * after the mode preset and CLI flags have been layered in.
 */
const esbuildDefaults = {
    entryPoints: ["./src/app.ts"],
    format: "esm",
    splitting: false,
    outdir: "dist",
    outExtension: { ".js": ".mjs" },
    minify: false,
    sourcemap: "inline",
    bundle: true,
    platform: "browser",
};

/**
 * Fully-resolved build config: every key present, defaults applied.
 *
 * Also used by `init-config --esbuild` to scaffold a populated file, so
 * `parse({})` must yield the defaults above.
 */
export const esbuildConfigSchema = z.object(esbuildShape).extend({
    entryPoints: esbuildShape.entryPoints.default(esbuildDefaults.entryPoints),
    format: esbuildShape.format.default(esbuildDefaults.format),
    splitting: esbuildShape.splitting.default(esbuildDefaults.splitting),
    outdir: esbuildShape.outdir.default(esbuildDefaults.outdir),
    outExtension: esbuildShape.outExtension.default(esbuildDefaults.outExtension),
    minify: esbuildShape.minify.default(esbuildDefaults.minify),
    sourcemap: esbuildShape.sourcemap.default(esbuildDefaults.sourcemap),
    bundle: esbuildShape.bundle.default(esbuildDefaults.bundle),
    platform: esbuildShape.platform.default(esbuildDefaults.platform),
});

/**
 * Per-mode build presets. Applied *under* the config file and CLI flags, so an
 * explicit user value always wins; anything the user leaves unset falls back
 * to these.
 *
 * `conditions`/`mainFields` are the important ones: they decide which files
 * get pulled out of `node_modules`, so `--dev` can resolve a package's
 * `development` condition while `--prod` takes its default production build.
 *
 * @type {Record<string, Record<string, unknown>>}
 */
const MODE_PRESETS = {
    development: {
        minify: false,
        sourcemap: "inline",
        treeShaking: false,
        define: { "process.env.NODE_ENV": JSON.stringify("development") },
        conditions: DEV_CONDITIONS,
        mainFields: DEV_MAIN_FIELDS,
    },
    production: {
        minify: true,
        sourcemap: false,
        treeShaking: true,
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        conditions: PROD_CONDITIONS,
        mainFields: PROD_MAIN_FIELDS,
    },
};

// --- CLI PARSER ---

/** `esbuild --init` scaffolds esbuild.config.json; anything else is a run. */
const esbuildParser = object({
    init: optional(
        option("--init", {
            description: message`Scaffold the default config file and exit`,
        }),
    ),
    define: map(
        multiple(option("--define", string({ metavar: "KEY=VALUE" }))),
        (v) => (v.length ? Object.fromEntries(v.map((s) => s.split(/=(.*)/s).slice(0, 2))) : undefined),
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
    prod: optional(
        option("--prod", {
            description: message`Production build: minify, no sourcemaps, production package conditions`,
        }),
    ),
    dev: optional(
        option("--dev", {
            description: message`Development build (default): readable output, sourcemaps, development package conditions`,
        }),
    ),

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
 * Render esbuild's structured diagnostics (the `errors` array the wasm API
 * rejects with) as red terminal lines. Falls back to the cause's message.
 *
 * @param {any} term terminal sink
 * @param {unknown} cause the raw esbuild failure inside a {@link BuildError}
 * @returns {string} short first-line summary (for the watcher strip detail)
 */
function logBuildErrors(term, cause) {
    const errors = /** @type {any} */ (cause)?.errors;
    if (Array.isArray(errors) && errors.length) {
        for (const m of errors) {
            const loc = m.location
                ? ` (${m.location.file}:${m.location.line}:${m.location.column})`
                : "";
            term.error(`✗ ${m.text}${loc}`);
        }
        const first = errors[0];
        return `${first?.text ?? "build failed"}${
            first?.location ? ` (${first.location.file}:${first.location.line})` : ""
        }`;
    }
    const msg = describeBuildCause(cause);
    term.error(`✗ ${msg}`);
    return msg;
}

/** Adapter so helpers written for a StatusGroup can log to plain lines.
 * @param {any} term terminal sink
 */
function logToTerm(term) {
    return /** @type {import('../effects/terminal-ui.mjs').StatusGroup} */ ({
        /** @param {string} text */
        log(text) {
            term.info(text);
        },
    });
}


export default createCommand({
    name: "esbuild",
    parser: esbuildParser,
    aliases: ["build"],
    description: message`Bundle files using esbuild`,
    usage: message`esbuild init | esbuild [entry_points..] [--prod | --dev] [options]`,
    brief: message`Bundle files using esbuild (--dev default, --prod optimized)`,

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
                    // Deliberately omits minify/sourcemap: those are mode-controlled
                    // (--dev/--prod). Pinning them here would let the config
                    // file override the mode preset and make --prod a no-op.
                    const scaffold = {
                        entryPoints: ["src/app.tsx"],
                        outdir: "dist",
                        bundle: true,
                        format: "esm",
                        target: "es2022",
                    };
                    yield* Effect.tryPromise({
                        try: () => fs.writeFile(configPath, `${JSON.stringify(scaffold, null, 2)}\n`, "utf8"),
                        catch: FsError("writeFile", configPath),
                    });
                    term.success(`Wrote ${configPath} — edit entryPoints/outdir to match your project.`);
                    term.info("Run with --prod for an optimized build, --dev (default) for development.");
                    return undefined;
                }

                // --- config loading + validation (early returns keep the
                // old behaviour: friendly terminal error, no crash) ---
                const required = Boolean(parsed.config);
                const rawConfigResult = yield* Effect.either(readJsonConfigEffect(configPath, { required }));
                if (rawConfigResult._tag === "Left") {
                    if (required) {
                        term.error(`${configPath}: ${describeError(rawConfigResult.left)}`);
                        return undefined;
                    }
                }
                const rawConfig =
                    rawConfigResult._tag === "Right" ? rawConfigResult.right : {};

                // Read the config file *without* defaults so we can tell an
                // explicit `minify: false` apart from an absent key. A default
                // applied here would outrank the --prod preset.
                const configResult = esbuildRawSchema.safeParse(rawConfig);
                if (!configResult.success) {
                    term.error(`${configPath}: ${zodIssuesMessage(configResult.error)}`);
                    return undefined;
                }
                const fileConfig = configResult.data;

                if (parsed.prod && parsed.dev) {
                    term.error("Pass either --prod or --dev, not both.");
                    return undefined;
                }
                const mode = parsed.prod ? "production" : "development";
                const preset = MODE_PRESETS[mode];

                const { config: _c, init: _i, prod: _p, dev: _d, ...cliFields } = parsed;
                const provided = dropUndefined(cliFields);
                // `define` and `conditions` merge rather than override: both are
                // additive in esbuild. A config listing `conditions: ["production"]`
                // means "additionally match production", not "match only
                // production" — treating it as a replacement would deactivate
                // `browser`/`import`/`default` and silently drop every package to
                // the legacy mainFields fallback.
                const mergedResult = esbuildConfigSchema.safeParse({
                    ...preset,
                    ...fileConfig,
                    ...provided,
                    define: {
                        .../** @type {Record<string,string>} */ (preset.define),
                        ...fileConfig.define,
                        ...provided.define,
                    },
                    conditions: [
                        ...(preset.conditions ?? []),
                        ...(fileConfig.conditions ?? []),
                        ...(provided.conditions ?? []),
                    ],
                });
                if (!mergedResult.success) {
                    term.error(`Config merge: ${zodIssuesMessage(mergedResult.error)}`);
                    return undefined;
                }
                const merged = mergedResult.data;
                const watchMode = merged.watch;
                const { watch: _w, entryPoints: epPatterns, ...rest } = merged;
                void _w;

                // --- entry point resolution ---
                const fs = yield* WorkspaceFs;
                const ui = yield* TerminalUi;
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
                 * Per-file "wrote" lines go into the group's collapsed body;
                 * the summary line is updated by the caller.
                 * @param {import('esbuild-wasm').BuildResult} result
                 * @param {import('../effects/terminal-ui.mjs').StatusGroup} group
                 * @returns {Effect.Effect<void, FsError>}
                 */
                const writeOutputs = (result, group) =>
                    Effect.forEach(
                        result.outputFiles ?? [],
                        (/** @type {import('esbuild-wasm').OutputFile} */ output) =>
                            Effect.tryPromise({
                                try: () => fs.writeFile(output.path, output.contents),
                                catch: FsError("writeFile", output.path),
                            }).pipe(
                                Effect.tap(() =>
                                    Effect.sync(() =>
                                        group.log(`✓ wrote ${output.path} (${output.contents.length} bytes)`),
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
                    // Pinned status row (terminal strip): one per watcher id,
                    // updated in place by every rebuild.
                    const watcher = ui.startWatcher("esbuild-watch", `esbuild --watch${mode === "production" ? " --prod" : ""}`);
                    watcher.set("building", resolvedEntryPoints.join(", "));

                    /**
                     * Rebuild + write outputs as an Effect. Serialized and
                     * debounced by the watch pipeline, so concurrent
                     * `fs:changed` bursts never cause overlapping rebuilds.
                     * @param {{ path: string, type: string }} e
                     */
                    const rebuildEffect = (e) =>
                        Effect.gen(function* () {
                            yield* Effect.logDebug(`rebuild triggered by ${e.type} ${e.path}`);
                            const t0 = performance.now();
                            watcher.set("building", e.path);
                            term.info(`▶ Rebuilding on ${e.type} ${e.path}`);
                            const result = yield* Effect.tryPromise({
                                try: () => context.rebuild(),
                                catch: BuildError("rebuild"),
                            }).pipe(
                                Effect.tapError((/** @type {any} */ cause) => Effect.sync(() => {
                                    const first = logBuildErrors(term, cause.cause);
                                    term.error(`✗ Rebuild failed — ${e.path}`);
                                    watcher.set("error", first);
                                })),
                            );
                            filesToWatch = Object.keys(result.metafile?.inputs ?? {}).map((v) => v.split(":")[1]);
                            // Per-file "wrote" lines go straight to the
                            // terminal as plain logs (no collapsible card on
                            // the watch hot path).
                            yield* writeOutputs(result, logToTerm(term));
                            recordWrites((result.outputFiles ?? []).map((o) => o.path));
                            const count = result.outputFiles?.length ?? 0;
                            const elapsed = Math.round(performance.now() - t0);
                            term.success(`✓ Rebuilt ${count} file(s) · ${elapsed}ms`);
                            watcher.set("ok", `${count} file(s) · ${elapsed}ms`);
                            yield* Effect.logDebug(`rebuilt ${count} output file(s) in response to ${e.path}`);
                        }).pipe(
                            Effect.withSpan("esbuild.rebuild", { attributes: { trigger: e.path } }),
                        );

                    // Initial rebuild under the dev span.
                    const group = yield* Effect.sync(() => ui.startGroup("Building:", `${mode} · ${resolvedEntryPoints.join(", ")}`));
                    const result = yield* Effect.tryPromise({
                        try: () => context.rebuild(),
                        catch: BuildError("rebuild"),
                    }).pipe(
                        Effect.tapError((/** @type {any} */ cause) => Effect.sync(() => {
                            group.set("Failed:", "", "#f14c4c");
                            group.fail();
                            const first = logBuildErrors(term, cause.cause);
                            watcher.set("error", first);
                        })),
                    );
                    filesToWatch = Object.keys(result.metafile?.inputs ?? {}).map((v) => v.split(":")[1]);
                    yield* writeOutputs(result, group).pipe(
                        Effect.withSpan("esbuild.dev", { attributes: { mode: "watch" } }),
                        Effect.tap(() => Effect.sync(() => recordWrites((result.outputFiles ?? []).map((o) => o.path)))),
                    );
                    group.set("Built:", "", "#4ec9b0");
                    group.detail(`${result.outputFiles?.length ?? 0} file(s)`);
                    watcher.set("ok", `${result.outputFiles?.length ?? 0} file(s)`);
                    yield* Effect.logInfo(`watching for changes (${filesToWatch.length} source file(s))`);

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
                    attachWatchStop(watcher, {
                        pipeline,
                        unsub,
                        onDispose: () => context.dispose(),
                    });
                    return undefined;
                } else {
                    const esb = yield* getEsbuildEffect;
                    const { analyze, ..._buildOptions } = buildOptions;
                    const group = yield* Effect.sync(() => ui.startGroup("Building:", `${mode} · ${resolvedEntryPoints.join(", ")}`));
                    const result = yield* Effect.tryPromise({
                        try: () => esb.build(_buildOptions),
                        catch: BuildError("build"),
                    }).pipe(
                        Effect.tapError((/** @type {any} */ err) => Effect.sync(() => {
                            group.set("Failed:", "", "#f14c4c");
                            group.fail();
                            logBuildErrors(term, err.cause);
                        })),
                    );
                    yield* writeOutputs(result, group).pipe(
                        Effect.withSpan("esbuild.build", {
                            attributes: { entries: String(resolvedEntryPoints.length) },
                        }),
                    );
                    recordWrites((result.outputFiles ?? []).map((o) => o.path));
                    group.set("Built:", "", "#4ec9b0");
                    group.detail(`${result.outputFiles?.length ?? 0} file(s)`);
                    if (result.metafile) {
                        group.log(
                            `metafile: ${Object.keys(result.metafile.inputs).length} inputs, ${Object.keys(result.metafile.outputs).length} outputs`,
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
