import { dirname, join } from "../utils/path.mjs";
import * as z from "zod";
import { createCommand } from "../services/commands.mjs";
import { object, optional, message, option, string, multiple, map } from "@optique/core";
import { aliasPlugin, fsPlugin, getEsbuildEffect, httpPlugin, BuildError, describeBuildCause } from "../utils/esbuild.mjs";
import picomatch from "picomatch";
import { Effect } from "effect";
import { WorkspaceFs } from "../effects/services.mjs";
import { FsError } from "./fs.mjs";
import { createWatchPipeline } from "../effects/watch-pipeline.mjs";
import { bus } from "../services/bus.mjs";

// import * as oxide from "https://esm.sh/@tailwindcss/oxide-wasm32-wasi"


// const scanner = new oxide.Scanner({})

// console.log(scanner)
// const d = scanner.getCandidatesWithPositions({
//   content: `<div class="p-4 bg-blue-500">Hello</div>`,
//   extension:"html"
// })


const TAILWIND_VERSION = "4.1.6";
const COMPILE_URL = `https://esm.sh/tailwindcss@${TAILWIND_VERSION}`;
const ISO_URL = "https://cdn.jsdelivr.net/npm/tailwindcss-iso@1.0.6/dist/browser.js";
const CSS_BASE = `https://cdn.jsdelivr.net/npm/tailwindcss@${TAILWIND_VERSION}`;

/** @type {Map<string, string>} */
const cssCache = new Map();

/**
 * Typed tailwind failure — carries the operation so error mapping can
 * produce a single friendly line.
 * @typedef {{ _tag: "TailwindError", op: string, cause: unknown }} TailwindError
 */

/**
 * Error factory for {@link TailwindError}.
 * @param {string} op
 * @returns {(cause: unknown) => TailwindError}
 */
const TailwindError = (op) => (cause) => ({
    _tag: /** @type {const} */ ("TailwindError"),
    op,
    cause,
});

/**
 * Describe a typed failure on a single line.
 * @param {{ _tag: string, op?: string, cause?: unknown }} e
 * @returns {string}
 */
function describeError(e) {
    return `${e.op || e._tag}: ${describeBuildCause(e.cause)}`;
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

/** @type {((css: string, opts: any) => any) | null} */
let _compile = null;

/**
 * Memoized tailwind compile init (Effect.cached — module import runs at most
 * once and its result is shared by every subsequent build).
 *
 * @type {Effect.Effect<(css: string, opts: any) => any, TailwindError>}
 */
const getCompileEffect = /** @type {any} */ (
    Effect.runSync(
        Effect.cached(
            Effect.tryPromise({
                try: async () => {
                    if (!_compile) {
                        const mod = await import(COMPILE_URL);
                        _compile = mod.compile;
                    }
                    return /** @type {(css: string, opts: any) => any} */ (_compile);
                },
                catch: TailwindError("init"),
            }),
        ),
    )
);

/** @type {((opts: { content: string, extension: string }) => string[]) | null} */
let _getTailwindClasses = null;

/**
 * Memoized wasm scanner init (Effect.cached, same pattern as compile).
 *
 * @type {Effect.Effect<(opts: { content: string, extension: string }) => string[], TailwindError>}
 */
const getScannerEffect = /** @type {any} */ (
    Effect.runSync(
        Effect.cached(
            Effect.tryPromise({
                try: async () => {
                    if (!_getTailwindClasses) {
                        const mod = await import(ISO_URL);
                        _getTailwindClasses = mod.getTailwindClasses;
                    }
                    return /** @type {(opts: { content: string, extension: string }) => string[]} */ (_getTailwindClasses);
                },
                catch: TailwindError("init"),
            }),
        ),
    )
);

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
async function getCSSAsset(name) {
    if (cssCache.has(name)) return /** @type {string} */ (cssCache.get(name));
    const url = `${CSS_BASE}/${name}.css`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch tailwindcss asset: ${name}`);
    const text = await res.text();
    cssCache.set(name, text);
    return text;
}

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {(id: string, base: string) => Promise<{path: string, base: string, content: string}>}
 */
function createLoadStylesheet(fs) {
    return async (id, base) => {
        const name = id.replace(/\.css$/, "");
        if (name === "tailwindcss") {
            return {
                path: "virtual:tailwindcss/index.css",
                base: "/",
                content: await getCSSAsset("index"),
            };
        }
        if (name === "tailwindcss/preflight" || name === "./preflight") {
            return {
                path: "virtual:tailwindcss/preflight.css",
                base: "/",
                content: await getCSSAsset("preflight"),
            };
        }
        if (name === "tailwindcss/theme" || name === "./theme") {
            return {
                path: "virtual:tailwindcss/theme.css",
                base: "/",
                content: await getCSSAsset("theme"),
            };
        }
        if (name === "tailwindcss/utilities" || name === "./utilities") {
            return {
                path: "virtual:tailwindcss/utilities.css",
                base: "/",
                content: "@tailwind utilities;",
            };
        }

        if (id.startsWith("http://") || id.startsWith("https://")) {
            const res = await fetch(id);
            return { path: id, base, content: await res.text() };
        }

        const fullPath = base && base !== "/" ? join(base, id) : id;
        const content = await fs.readFile(fullPath, { encoding: "utf8" });
        return { path: fullPath, base: dirname(fullPath) || "/", content };
    };
}

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {(id: string, base: string) => Promise<{path: string, base: string, module: any}>}
 */
function createLoadModule(fs) {
    return async (id, base) => {
        if (id.startsWith("http://") || id.startsWith("https://")) {
            const mod = await import(id);
            return { path: id, base, module: mod.default || mod };
        }

        if (!id.startsWith("./") && !id.startsWith("../") && !id.startsWith("/")) {
            const mod = await import(`https://esm.sh/${id}`);
            return { path: id, base, module: mod.default || mod };
        }

        const fullPath = base && base !== "/" ? join(base, id) : id;
        const esb = await Effect.runPromise(getEsbuildEffect);
        const result = await esb.build({
            entryPoints: [fullPath],
            bundle: true,
            format: "esm",
            write: false,
            plugins: [aliasPlugin(), httpPlugin(), fsPlugin(fs)],
        });
        const blob = new Blob([result.outputFiles[0].text], {
            type: "application/javascript",
        });
        const url = URL.createObjectURL(blob);
        try {
            const mod = await import(url);
            return {
                path: fullPath,
                base: dirname(fullPath) || "/",
                module: mod.default || mod,
            };
        } finally {
            URL.revokeObjectURL(url);
        }
    };
}

/**
 * @param {object} config
 * @param {string | string[]} [config.input]
 * @param {string} [config.importCSS]
 * @param {string[]} [config.plugins]
 * @returns {string}
 */
function buildCSSInput(config) {
    if (Array.isArray(config.input)) {
        return config.input
            .map((item) => {
                const t = item.trim();
                if (t.startsWith("@") || t.startsWith("http://") || t.startsWith("https://")) return t;
                return `@import "${t}"`;
            })
            .join("\n");
    }
    const parts = [];
    if (config.importCSS) parts.push(config.importCSS);
    else parts.push('@import "tailwindcss"');
    if (config.input && typeof config.input === "string") parts.push(`@import "${config.input}"`);
    if (config.plugins) {
        for (const p of config.plugins) {
            if (p.startsWith("http://") || p.startsWith("https://") || p.startsWith("./") || p.startsWith("/")) {
                parts.push(`@import "${p}"`);
            } else {
                parts.push(`@plugin "${p}"`);
            }
        }
    }
    return parts.join("\n");
}

/**
 * Scan the workspace for candidate classes via the wasm scanner.
 *
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {string[]} globs
 * @returns {Effect.Effect<string[], TailwindError>}
 */
function extractClassesEffect(fs, globs) {
    const isMatch = picomatch(globs.map((g) => g.replace(/^\.\//, "")));
    return Effect.gen(function* () {
        const getClasses = yield* getScannerEffect;
        const files = yield* Effect.tryPromise({
            try: () => fs.getFilesFromDirectory("", isMatch),
            catch: TailwindError("scan"),
        });

        /** @type {Record<string, string[]>} */
        const byExt = {};
        for (const [filePath, content] of files) {
            const dot = filePath.lastIndexOf(".");
            if (dot === -1) continue;
            const ext = filePath.slice(dot + 1);
            (byExt[ext] ||= []).push(content);
        }

        const classes = new Set();
        // Concurrency 1: scanner calls run in deterministic extension order.
        const exts = Object.keys(byExt);
        for (const ext of exts) {
            const results = yield* Effect.tryPromise({
                try: () => Promise.resolve(getClasses({ content: byExt[ext].join("\n"), extension: ext })),
                catch: TailwindError("scan"),
            });
            for (const r of results) {
                classes.add(r);
            }
        }

        return [...classes];
    });
}

/**
 * Full tailwind build flow as an Effect (span `tailwind.build`, typed
 * {@link TailwindError} failures mapped to friendly Errors).
 *
 * @param {{ files?: string[], input?: string | string[], importCSS?: string, output?: string, plugins?: string[] }} config
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {Effect.Effect<{output: string, bytes: number, classes: number}, Error>}
 */
function runBuildEffect(config, fs) {
    return Effect.gen(function* () {
        const compile = yield* getCompileEffect;
        const cssInput = buildCSSInput(config);
        const compiler = yield* Effect.tryPromise({
            try: () =>
                Promise.resolve(compile(cssInput, {
                    base: "/",
                    loadStylesheet: createLoadStylesheet(fs),
                    loadModule: createLoadModule(fs),
                })),
            catch: TailwindError("compile"),
        });
        const globs =
            config.files && config.files.length > 0
                ? config.files
                : ["./src/**/*.{html,js,ts,jsx,tsx,mjs}"];
        const classes = yield* extractClassesEffect(fs, globs);
        const result = yield* Effect.tryPromise({
            try: () => Promise.resolve(compiler.build(classes)),
            catch: TailwindError("build"),
        });
        const output = config.output || "./dist/tailwind.css";
        const dir = dirname(output);
        if (dir) {
            yield* Effect.tryPromise({
                try: () => fs.mkdir(dir, { recursive: true }),
                catch: TailwindError("mkdir"),
            }).pipe(Effect.ignore);
        }
        yield* Effect.tryPromise({
            try: () => fs.writeFile(output, result),
            catch: TailwindError("write"),
        });
        return { output, bytes: result.length, classes: classes.length };
    }).pipe(
        Effect.withSpan("tailwind.build", { attributes: { output: config.output || "./dist/tailwind.css" } }),
        Effect.withLogSpan("tailwind.build"),
        Effect.mapError(
            (/** @type {TailwindError} */ e) => friendlyError(describeError(e)),
        ),
    );
}

const tailwindParser = object({
    init: optional(
        option("--init", {
            description: message`Scaffold the default config file and exit`,
        }),
    ),
    config: optional(
        option("-c", "--config", string({ metavar: "FILE" }), {
            description: message`Path to config file (default: tailwind.config.json)`,
        }),
    ),
    input: map(
        optional(
            option("-i", "--input", string({ metavar: "FILE" }), {
                description: message`Input CSS file`,
            }),
        ),
        (s) => (s ? [s] : undefined),
    ),
    output: optional(
        option("-o", "--output", string({ metavar: "FILE" }), {
            description: message`Output CSS file`,
        }),
    ),
    watch: optional(
        option("--watch", {
            description: message`Watch for changes and rebuild`,
        }),
    ),
    files: multiple(
        option("--files", string({ metavar: "GLOB" }), {
            description: message`Glob pattern for content files to scan`,
        }),
    ),
});

export const tailwindConfigSchema = z.object({
    files: z
        .union([z.string(), z.array(z.string())])
        .transform((v) => (typeof v === "string" ? [v] : v))
        .optional(),

    input: z.union([z.string(), z.array(z.string())]).optional(),
    output: z.string().optional(),
    importCSS: z.string().optional(),
    plugins: z.array(z.string()).optional(),
});

export default createCommand({
    name: "tailwind",
    parser: tailwindParser,
    aliases: ["tw"],
    description: message`Generate Tailwind CSS using compile() API with WasmScanner`,
    usage: message`tailwind [--init] [-i FILE] [-o FILE] [--watch] [--content GLOB]...`,
    brief: message`Generate Tailwind CSS using compile() API with WasmScanner`,
    /**
     * @param {import("@optique/core").InferValue<typeof tailwindParser>} parsed
     * @param {import("../types/terminal.d.ts").Terminal} term
     * @returns {Effect.Effect<undefined, Error>}
     */
    timeoutSeconds: 300,
    executeEffect: (parsed, term) => {
        const configPath = parsed.config || "tailwind.config.json";

        return /** @type {Effect.Effect<undefined, Error>} */ (
            Effect.gen(function* () {
                const fs = yield* WorkspaceFs;

                // --- `tailwind --init`: scaffold the default config file ---
                if (parsed.init) {
                    if (yield* Effect.tryPromise({ try: () => fs.exists(configPath), catch: () => false })) {
                        term.error(`${configPath} already exists — remove it first if you want to re-scaffold.`);
                        return undefined;
                    }
                    const scaffold = {
                        files: ["./**/*.html", "./src/**/*.{js,mjs}"],
                        output: "./dist/tailwind.css",
                    };
                    yield* Effect.tryPromise({
                        try: () => fs.writeFile(configPath, `${JSON.stringify(scaffold, null, 2)}\n`, "utf8"),
                        catch: FsError("writeFile", configPath),
                    });
                    term.success(`Wrote ${configPath} — edit files globs and output to match your project.`);
                    return undefined;
                }

                // --- config loading + validation (early returns keep the
                // old behaviour: friendly terminal error, no crash) ---
                const required = Boolean(parsed.config);

                /** @type {any} */
                let rawConfig = {};
                const readResult = yield* Effect.either(
                    Effect.tryPromise({
                        try: () => fs.readFile(configPath, { encoding: "utf8" }),
                        catch: FsError("readFile", configPath),
                    }).pipe(
                        Effect.flatMap((content) =>
                            Effect.try({
                                try: () => JSON.parse(/** @type {string} */ (content)),
                                catch: FsError("parse", configPath),
                            }),
                        ),
                    ),
                );
                if (readResult._tag === "Left") {
                    if (required) {
                        term.error(`${configPath}: ${describeBuildCause(readResult.left.cause)}`);
                        return undefined;
                    }
                } else {
                    rawConfig = readResult.right;
                }

                const configResult = tailwindConfigSchema.safeParse(rawConfig);
                if (!configResult.success) {
                    term.error(`${configPath}: ${configResult.error.issues.map((i) => i.message).join(", ")}`);
                    return undefined;
                }
                const validatedConfig = configResult.data;

                const { config: _, ...cliFields } = parsed;
                const mergedResult = tailwindConfigSchema.safeParse({
                    ...validatedConfig,
                    ...cliFields,
                });
                if (!mergedResult.success) {
                    term.error(`Config merge: ${mergedResult.error.issues.map((i) => i.message).join(", ")}`);
                    return undefined;
                }
                const config = mergedResult.data;

                const sub = parsed.watch ? "watch" : "build";

                if (sub === "watch") {
                    const first = yield* runBuildEffect(config, term.fs);
                    term.success(`Built ${first.output} (${first.bytes} bytes, ${first.classes} classes)`);

                    const isMatch = picomatch((config.files ?? []).map((/** @type {string} */ g) => g.replace(/^\.\//, "")));

                    const pipeline = createWatchPipeline({
                        name: "tailwind-watch",
                        debounceMs: 200,
                        match: isMatch,
                        handler: () =>
                            runBuildEffect(config, term.fs).pipe(
                                Effect.tap((r) =>
                                    Effect.sync(() =>
                                        term.info(`Rebuilt ${r.output} (${r.bytes} bytes, ${r.classes} classes)`),
                                    ),
                                ),
                            ),
                        term,
                    });

                    const unsub = bus.on("fs:changed", (/** @type {CustomEvent} */ e) => {
                        pipeline.push(/** @type {any} */ (e).detail);
                    });
                    const stopBtn = document.createElement("button");
                    stopBtn.textContent = "⏹ stop watching";
                    stopBtn.addEventListener("click", () => {
                        unsub();
                        pipeline.stop();
                        stopBtn.remove();
                    });
                    term.log(stopBtn);

                    term.info("Watching for changes...");
                    return undefined;
                } else {
                    const { output, bytes, classes } = yield* runBuildEffect(config, term.fs);
                    term.success(`Wrote ${output} (${bytes} bytes, ${classes} classes)`);
                    return undefined;
                }
            }).pipe(
                Effect.mapError(
                    (/** @type {any} */ e) =>
                        friendlyError(
                            e instanceof Error ? e.message : describeError(e),
                        ),
                ),
            )
        );
    },
});
