import { WebFileSystem } from "../fs.mjs";
import { dirname, join, EXTENSIONS } from "../utils/path.mjs";
import { readJSON } from "../utils/json.mjs";
import { object, optional, flag, option, string, passThrough, message } from "@optique/core";
import { createCommand } from "../terminal.mjs";

// ---- esbuild-wasm (lazy loaded) ----
const ESBUILD_CDN = "https://unpkg.com/esbuild-wasm@0.28.1/esm/browser.min.js";

/** @type {typeof import('esbuild-wasm') | null} */
let esbuild = null;

/** @returns {Promise<typeof import('esbuild-wasm')>} */
export async function getEsbuild() {
    if (!esbuild) {
        esbuild = await import(ESBUILD_CDN);
        if (!esbuild) throw new Error(`Error loading esbuild`);
        await esbuild.initialize({
            worker: true,
            wasmURL: "https://unpkg.com/esbuild-wasm@0.28.1/esbuild.wasm",
        });
    }
    return /** @type {typeof import('esbuild-wasm')} */ (esbuild);
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
 * @param {import('../fs.mjs').WebFileSystem} fs
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
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function resolveDirectory(fs, dir) {
    const pkg = join(dir, "package.json");
    if (await fs.stat(pkg)) {
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
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} specifier
 * @param {string} importerDir
 * @returns {Promise<string | null>}
 */
async function resolveNodeModule(fs, specifier, importerDir) {
    const parts = specifier.split("/");
    const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const subpath = specifier.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/");
    let current = importerDir;

    while (true) {
        const root = join(current, "node_modules", packageName);
        if (await fs.stat(join(root, "package.json"))) {
            const pkg = await readJSON(fs, join(root, "package.json"));
            if (!pkg) return null;

            if (subpath) {
                return (
                    (await resolveFile(fs, join(root, subpath))) ?? (await resolveDirectory(fs, join(root, subpath)))
                );
            }

            const entry = pkg.module ?? pkg.browser ?? pkg.main ?? "index";
            return (await resolveFile(fs, join(root, entry))) ?? (await resolveDirectory(fs, join(root, entry)));
        }

        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return null;
}

// --- ESBUILD PLUGINS ---


export function aliasPlugin() {
    return {
        name: "alias-plugin",
        /** @param {import('esbuild-wasm').PluginBuild} build */
        setup(build) {
            const aliases = build.initialOptions.alias ?? {}
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

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
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
                    return { contents, loader: "default" };
                },
            );
        },
    };
}

// --- STATE AND CORE BUNDLING ---

const defaultConfig = {
    bundle: true,
    minify: false,
    format: "esm",
};

/**
 * @param {Record<string, any>} config
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {Set<string>} [trackedFiles]
 */
function buildOptions(config, fs, trackedFiles) {
    return {
        ...defaultConfig,
        ...config,
        write: false,
        plugins: [aliasPlugin(), httpPlugin(), fsPlugin(fs)],
    };
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {import('esbuild-wasm').BuildResult} result
 * @returns {Promise<import('esbuild-wasm').OutputFile[]>}
 */
async function writeOutputs(fs, result) {
    for (const file of result.outputFiles || []) {
        await fs.writeFile(file.path, file.contents);
    }
    return result.outputFiles || [];
}

