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
 * @param {string[]} [mainFields]
 * @returns {Promise<string | null>}
 */
async function resolveDirectory(fs, dir, mainFields = DEFAULT_MAIN_FIELDS) {
    const pkg = join(dir, "package.json");
    if (await fs.exists(pkg)) {
        const json = await readJSON(fs, pkg);
        if (json) {
            const entry = mainFields
                .map((f) => /** @type {any} */ (json)[f])
                .find((v) => typeof v === "string" && v);
            if (entry) {
                /** @type {string | null} */
                const resolved =
                    (await resolveFile(fs, join(dir, entry))) ??
                    (await resolveDirectory(fs, join(dir, entry), mainFields));
                if (resolved) return resolved;
            }
        }
    }
    return resolveFile(fs, join(dir, "index"));
}

/**
 * Turn an `exports` target into a real file path, probing the filesystem.
 *
 * The `exports` array sugar (`["./browser.js", "./node.js"]`) exists to let
 * bundlers skip entries that don't apply, so each array entry is probed and
 * the first one that actually exists wins.
 *
 * A non-array target is different: matching a condition is *authoritative*.
 * The package said "under these conditions, this exact file is the entry
 * point". If we then fail to find it on disk and quietly fall through to the
 * legacy `module`/`main` fields, we resolve a completely different build than
 * the package intended — typically the server bundle of a library that also
 * ships a browser one, which then fails to resolve server-only dependencies
 * with a bewildering error several modules later. So a condition match that
 * misses the filesystem is reported as unresolved instead of being downgraded.
 *
 * @param {import('../types/services.d.ts').WorkspaceFsService} fs
 * @param {string} root package root (the directory holding package.json)
 * @param {string | string[] | Record<string, any>} target
 * @param {string[]} conditions
 * @param {string[]} mainFields
 * @returns {Promise<{ path: string | null, matched: boolean }>} `matched` is
 *   true when a condition matched but no candidate exists on disk.
 */
async function resolveExportTarget(fs, root, target, conditions, mainFields) {
    /** @type {string[]} */
    const candidates = [];
    const isArray = Array.isArray(target);
    if (isArray) {
        for (const entry of /** @type {string[]} */ (target)) {
            const resolved = resolveConditionalExport(entry, conditions);
            if (resolved) candidates.push(resolved);
        }
    } else {
        const resolved = resolveConditionalExport(target, conditions);
        if (resolved) candidates.push(resolved);
    }

    for (const candidate of candidates) {
        const fullPath = join(root, candidate);
        // File first, then directory (handles "./dist/" style targets).
        const resolved =
            (await resolveFile(fs, fullPath)) ??
            (await resolveDirectory(fs, fullPath, mainFields));
        if (resolved) return { path: resolved, matched: true };
    }

    // No candidate. For an array that's a legitimate "none of these apply"
    // (the caller may fall back); for a single authoritative target it means
    // the file the package promised is missing.
    return { path: null, matched: candidates.length > 0 && !isArray };
}


/**
 * @param {import('../types/services.d.ts').WorkspaceFsService} fs
 * @param {string} specifier
 * @param {string} importerDir
 * @param {string[]} [conditions] export conditions, most-preferred first
 * @param {string[]} [mainFields] legacy entry-point fields, most-preferred first
 * @returns {Promise<string | null>}
 */
async function resolveNodeModule(fs, specifier, importerDir, conditions = DEFAULT_CONDITIONS, mainFields = DEFAULT_MAIN_FIELDS) {
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

            // `exports` is authoritative when present: pick the target matching
            // the active conditions, so --dev can land on a "development"
            // build and --prod on the default production build. String and
            // subpath forms ("./x") are handled, as is the array sugar.
            if (pkg.exports) {
                const subpathTarget =
                    typeof pkg.exports === "object" && !Array.isArray(pkg.exports)
                        ? pkg.exports[subpath]
                        : subpath === "."
                            ? pkg.exports
                            : undefined;

                if (subpathTarget) {
                    const r = await resolveExportTarget(fs, root, subpathTarget, conditions, mainFields);
                    if (r.path) return r.path;
                    // A condition matched but the file isn't there. Do NOT fall
                    // back to mainFields: that would silently swap in a
                    // different build than the package declared (commonly the
                    // server entry of a dual-published library). Report it.
                    if (r.matched) return null;
                }
            }

            // No exports map, or no branch matched: fall back to legacy
            // entry-point fields in mainFields order. `browser` leads so
            // browser builds prefer the browser entry over module/main.
            let entry = "index";
            for (const field of mainFields) {
                const value = /** @type {any} */ (pkg)[field];
                if (typeof value === "string" && value) {
                    entry = value;
                    break;
                }
            }
            return (
                (await resolveFile(fs, join(root, entry))) ??
                (await resolveDirectory(fs, join(root, entry), mainFields))
            );
        }

        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return null;
}


// --- RESOLUTION CONDITIONS / MAIN FIELDS ---

/**
 * Mode-specific condition *extras*.
 *
 * Packages ship different builds behind conditional `exports` maps — a
 * `development` condition pointing at unminified sources with verbose error
 * messages, the default condition pointing at the production build. Activating
 * `development` is therefore what makes `--dev` and `--prod` load different
 * files, rather than just producing differently-minified output.
 *
 * These are extras, not a full set: the platform baseline (`browser`/`node`,
 * `import`, `default`) is supplied by {@link effectiveConditions}. Keeping the
 * two separate is what lets a `platform: "node"` build avoid inheriting
 * `browser` from the mode preset.
 *
 * Not a priority list — within one exports object the package's own key order
 * decides precedence (see {@link resolveConditionalExport}).
 */
export const DEV_CONDITIONS = ["development"];
export const PROD_CONDITIONS = [];

/**
 * Legacy (pre-`exports`) entry-point fields, in resolution order. Unlike
 * conditions there is no package-declared order to defer to, so this list *is*
 * the priority: `browser` first because builds for the browser platform must
 * prefer the browser entry over `module`/`main`.
 */
export const DEV_MAIN_FIELDS = ["browser", "module", "main"];
export const PROD_MAIN_FIELDS = ["browser", "module", "main"];

/**
 * Platform baseline conditions. esbuild always activates these and treats a
 * user-supplied `conditions` array as *additive*, never as a replacement.
 *
 * Getting that wrong is not cosmetic: a config with `conditions: ["production"]`
 * read as a full replacement would deactivate `browser`/`import`/`default`, so
 * no branch of a normal `exports` map would match and every dependency would
 * silently drop to the legacy `mainFields` fallback.
 */
const PLATFORM_CONDITIONS = {
    browser: ["browser", "import", "default"],
    node: ["node", "import", "default"],
    neutral: ["import", "default"],
};

/**
 * Build the effective condition set: platform baseline, then the mode's
 * conditions (`development` in dev), then anything the user added.
 *
 * @param {string | undefined} platform
 * @param {string[]} [extra]
 * @returns {string[]}
 */
export function effectiveConditions(platform, extra) {
    const base = PLATFORM_CONDITIONS[/** @type {keyof typeof PLATFORM_CONDITIONS} */ (platform ?? "browser")]
        ?? PLATFORM_CONDITIONS.browser;
    const out = [...base];
    for (const c of extra ?? []) {
        if (!out.includes(c)) out.push(c);
    }
    return out;
}

/**
 * Baseline used when a caller supplies no platform and no extras. Matches
 * esbuild's own defaults for `platform: "browser"`.
 */
export const DEFAULT_CONDITIONS = PLATFORM_CONDITIONS.browser;
export const DEFAULT_MAIN_FIELDS = PROD_MAIN_FIELDS;

/**
 * Recursively resolves a path from a conditional exports object.
 *
 * Follows the Node.js `PACKAGE_EXPORTS_RESOLVE` algorithm: iterate the target
 * object's **own key order** and take the first key that is a member of the
 * active condition set, recursing when that branch is itself an object. Key
 * order wins over condition-list order, which is what Node, esbuild, and Vite
 * all do — iterating our conditions first instead would pick a different file
 * than Node does whenever a package lists two active conditions in an order we
 * don't happen to agree with.
 *
 * @param {string | string[] | Record<string, any>} target The current object or path string.
 * @param {string[]} activeConditions The conditions to match (e.g., ['browser', 'import']).
 * @returns {string | null} The resolved path string or null.
 */
function resolveConditionalExport(target, activeConditions) {
    // `"./x.js": ["./a.js", "./b.js"]` — the exports array sugar. Try each
    // entry in order and take the first that yields a path.
    if (Array.isArray(target)) {
        for (const entry of target) {
            const resolved = resolveConditionalExport(entry, activeConditions);
            if (resolved) return resolved;
        }
        return null;
    }

    if (typeof target === 'string') {
        // Base case: we've found a path string.
        return target;
    }

    if (typeof target === 'object' && target !== null) {
        // Object.keys preserves the declaration order the package author wrote,
        // which is the precedence the spec defines.
        for (const key of Object.keys(target)) {
            if (!activeConditions.includes(key)) continue;
            const resolved = resolveConditionalExport(target[key], activeConditions);
            if (resolved) return resolved;
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
                    const mainFields = build.initialOptions.mainFields ?? DEFAULT_MAIN_FIELDS;
                    resolved =
                        (await resolveFile(fs, fullPath)) ??
                        (await resolveDirectory(fs, fullPath, mainFields));
                } else {
                    // Read conditions/mainFields off initialOptions so the
                    // esbuild command can drive them per build mode.
                    const opts = build.initialOptions;
                    resolved = await resolveNodeModule(
                        fs,
                        args.path,
                        importerDir,
                        effectiveConditions(opts.platform, opts.conditions),
                        opts.mainFields ?? DEFAULT_MAIN_FIELDS,
                    );
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
