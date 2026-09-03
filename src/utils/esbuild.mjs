import { WebFileSystem } from "../services/fs.mjs";
import { dirname, join, EXTENSIONS } from "../utils/path.mjs";
import { readJSON } from "../utils/json.mjs";
import { object, optional, option, string, passThrough, message } from "@optique/core";
import { createCommand } from "../services/commands.mjs";
import { Effect } from "effect";

// ---- esbuild-wasm (lazy loaded) ----
const ESBUILD_CDN = "https://unpkg.com/esbuild-wasm@0.28.1/esm/browser.min.js";

/** @type {typeof import('esbuild-wasm') | null} */
let esbuild = null;

/**
 * Typed build failure — carries the esbuild operation so error mapping can
 * produce a single friendly line.
 * @typedef {{ _tag: "BuildError", op: string, cause: unknown }} BuildError
 */

/**
 * Error factory for {@link BuildError}.
 * @param {string} op
 * @returns {(cause: unknown) => BuildError}
 */
export const BuildError = (op) => (cause) => ({
    _tag: /** @type {const} */ ("BuildError"),
    op,
    cause,
});

/**
 * Describe a cause on a single line (no stack noise).
 * @param {unknown} cause
 * @returns {string}
 */
export function describeBuildCause(cause) {
    const msg =
        cause instanceof Error
            ? cause.message
            : /** @type {any} */ (cause)?.message ?? String(cause);
    return msg || "unknown error";
}

/** Lazily initializes esbuild-wasm as an Effect with a typed {@link BuildError}. */
const esbuildInitEffect = Effect.tryPromise({
    try: async () => {
        if (!esbuild) {
            esbuild = await import(ESBUILD_CDN);
            if (!esbuild) throw new Error(`Error loading esbuild`);
            await esbuild.initialize({
                worker: true,
                wasmURL: "https://unpkg.com/esbuild-wasm@0.28.1/esbuild.wasm",
            });
        }
        return /** @type {typeof import('esbuild-wasm')} */ (esbuild);
    },
    catch: BuildError("init"),
});

/**
 * Memoized esbuild-wasm init (Effect.cached — init runs at most once and its
 * result is shared by every subsequent use).
 *
 * @type {Effect.Effect<typeof import('esbuild-wasm'), BuildError>}
 */
export const getEsbuildEffect = /** @type {any} */ (
    Effect.runSync(Effect.cached(esbuildInitEffect))
);

/**
 * Thin Promise wrapper over {@link getEsbuildEffect} for non-Effect callers.
 *
 * @returns {Promise<typeof import('esbuild-wasm')>}
 */
export function getEsbuild() {
    return Effect.runPromise(getEsbuildEffect);
}

/**
 * Transform source with esbuild-wasm as an Effect (typed {@link BuildError}).
 *
 * @param {string | Uint8Array} input
 * @param {import('esbuild-wasm').TransformOptions} [options]
 * @returns {Effect.Effect<import('esbuild-wasm').TransformResult, BuildError>}
 */
export function transformEffect(input, options) {
    return Effect.flatMap(getEsbuildEffect, (esb) =>
        Effect.tryPromise({
            try: () => esb.transform(input, options),
            catch: BuildError("transform"),
        }),
    );
}

/**
 * Thin Promise wrapper over {@link transformEffect} for non-Effect callers.
 *
 * @param {string | Uint8Array} input
 * @param {import('esbuild-wasm').TransformOptions} [options]
 * @returns {Promise<import('esbuild-wasm').TransformResult>}
 */
export function transform(input, options) {
    return Effect.runPromise(transformEffect(input, options));
}

// --- RESOLVE HELPERS ---

/**
 * @param {string} contentType
 * @param {string} url
 * @returns {'js' | 'jsx' | 'css' | 'json' | 'text'}
 */
export function getLoaderFromContentType(contentType, url) {
    if (!contentType) {
        if (url.endsWith(".css")) return "css";
        if (url.endsWith(".json")) return "json";
        return "js";
    }
    if (contentType.includes("javascript") || contentType.includes("typescript")) return "jsx";
    if (contentType.includes("css")) return "css";
    if (contentType.includes("json")) return "json";
    if (contentType.includes("text")) return "text";
    return "text";
}

// --- RESOLVE HELPERS ---

/**
 * @param {import('../types/services.d.ts').WorkspaceFsService} fs
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function resolveFile(fs, path) {
    for (const ext of EXTENSIONS) {
        try {
            const stat = await fs.stat(path + ext);
            if (stat.type === "file") {
                return path + ext;
            }
        } catch (e) {}
    }
    return null;
}

/**
 * @param {import('../types/services.d.ts').WorkspaceFsService} fs
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function resolveDirectory(fs, dir) {
    const pkg = join(dir, "package.json");
    if (await fs.exists(pkg)) {
        const json = await readJSON(fs, pkg);
        if (json) {
            const entry = json.module ?? json.main;
            if (entry) {
                /** @type {string | null} */
                const resolved =
                    (await resolveFile(fs, join(dir, entry))) ?? (await resolveDirectory(fs, join(dir, entry)));
                if (resolved) return resolved;
            }
        }
    }
    return resolveFile(fs, join(dir, "index"));
}

/**
 * @param {import('../types/services.d.ts').WorkspaceFsService} fs
 * @param {string} specifier
 * @param {string} importerDir
 * @returns {Promise<string | null>}
 */
async function resolveNodeModule(fs, specifier, importerDir) {
    const parts = specifier.split("/");
    const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const subpath = specifier.startsWith("@")
        ? parts.length > 2
            ? "./" + parts.slice(2).join("/")
            : "."
        : parts.length > 1
          ? "./" + parts.slice(1).join("/")
          : ".";

    let current = importerDir;

    while (true) {
        const root = join(current, "node_modules", packageName);

        if (await fs.exists(join(root, "package.json"))) {
            const pkg = await readJSON(fs, join(root, "package.json"));
            if (!pkg) return null;

            if (pkg.exports) {
                const exportTarget = pkg.exports[subpath];

                if (exportTarget) {
                    const resolvedPath = resolveConditionalExport(exportTarget,["browser","import","default"])

                    if (resolvedPath) {
                        const finalPath = join(root, resolvedPath);
                        // Try resolving as a file first, then as a directory (for cases like "./dist/")
                        const resolved = (await resolveFile(fs, finalPath)) ?? (await resolveDirectory(fs, finalPath));
                        if (resolved) return resolved;
                    }
                }
            }

            // Resolve the main entry point if no subpath
            const entry = pkg.module ?? pkg.browser ?? pkg.main ?? "index";
            return (await resolveFile(fs, join(root, entry))) ?? (await resolveDirectory(fs, join(root, entry)));
        }

        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return null;
}


/**
 * Recursively resolves a path from a conditional exports object.
 * @param {string | Record<string, any>} target The current object or path string.
 * @param {string[]} activeConditions The conditions to match (e.g., ['browser', 'import']).
 * @returns {string | null} The resolved path string or null.
 */
function resolveConditionalExport(target, activeConditions) {
    if (typeof target === 'string') {
        // Base case: we've found a path string.
        return target;
    }

    if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
        // It's a conditional object. We must check our active conditions.
        for (const condition of activeConditions) {
            if (target.hasOwnProperty(condition)) {
                // Recursively call with the nested target.
                const result = resolveConditionalExport(target[condition], activeConditions);
                // Return the first valid path found.
                if (result) return result;
            }
        }
    }

    // No valid path found for the active conditions.
    return null;
}

/**
 * @param {import('../types/services.d.ts').WorkspaceFsService} fs
 */
export function fsPlugin(fs) {
    return {
        name: "browser-fs",
        /** @param {import('esbuild-wasm').PluginBuild} build */
        setup(build) {
            build.onResolve({ filter: /.*/ }, async (/** @type {import('esbuild-wasm').OnResolveArgs} */ args) => {
                if (build.initialOptions.external?.includes(args.path)) {
                    return { path: args.path, external: true };
                }

                const importerDir = args.kind === "entry-point" ? "" : dirname(args.importer);
                let resolved;

                if (args.path.startsWith(".") || args.path.startsWith("/")) {
                    const fullPath = join(importerDir, args.path);
                    resolved = (await resolveFile(fs, fullPath)) ?? (await resolveDirectory(fs, fullPath));
                } else {
                    resolved = await resolveNodeModule(fs, args.path, importerDir);
                }

                if (!resolved) {
                    return { errors: [{ text: `Cannot resolve '${args.path}'` }] };
                }

                return { path: resolved, namespace: "browser-fs" };
            });

            build.onLoad(
                { filter: /.*/, namespace: "browser-fs" },
                async (/** @type {import('esbuild-wasm').OnLoadArgs} */ args) => {
                    const contents = await fs.readFile(args.path, { encoding: "utf-8" });
                    return { contents: /** @type {string} */ (contents), loader: "default" };
                },
            );
        },
    };
}

export function aliasPlugin() {
    return {
        name: "alias-plugin",
        /** @param {import('esbuild-wasm').PluginBuild} build */
        setup(build) {
            const aliases = build.initialOptions.alias ?? {};
            build.onResolve({ filter: /.*/ }, (/** @type {import('esbuild-wasm').OnResolveArgs} */ args) => {
                if (build.initialOptions.external?.includes(args.path)) {
                    return { path: args.path, external: true };
                }
                for (const key of Object.keys(aliases)) {
                    if (args.path === key || args.path.startsWith(key + "/")) {
                        const alias = aliases[key];
                        return {
                            path: alias + args.path.slice(key.length),
                            namespace: alias.startsWith("http") ? "http-url" : args.namespace,
                        };
                    }
                }
                return;
            });
        },
    };
}

export function httpPlugin() {
    return {
        name: "http-plugin",
        /** @param {import('esbuild-wasm').PluginBuild} build */
        setup(build) {
            build.onResolve({ filter: /^https?:\/\// }, (/** @type {import('esbuild-wasm').OnResolveArgs} */ args) => ({
                path: args.path,
                namespace: "http-url",
            }));
            build.onResolve(
                { filter: /.*/, namespace: "http-url" },
                (/** @type {import('esbuild-wasm').OnResolveArgs} */ args) => ({
                    path: new URL(args.path, args.importer).toString(),
                    namespace: "http-url",
                }),
            );
            build.onLoad(
                { filter: /.*/, namespace: "http-url" },
                async (/** @type {import('esbuild-wasm').OnLoadArgs} */ args) => {
                    const cached = sessionStorage.getItem(args.path);
                    if (cached) return JSON.parse(cached);
                    try {
                        const response = await fetch(args.path);
                        const contents = await response.text();
                        const contentType = response.headers.get("Content-Type") || "";
                        const loader = getLoaderFromContentType(contentType, response.url);
                        const result = { contents, loader };
                        sessionStorage.setItem(response.url, JSON.stringify(result));
                        return result;
                    } catch {
                        return { errors: [{ text: `Could not fetch content from ${args.path}` }] };
                    }
                },
            );
        },
    };
}
