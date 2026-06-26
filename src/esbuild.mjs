import * as esbuild from "https://unpkg.com/esbuild-wasm@0.27.2/esm/browser.min.js";
import { WebFileSystem } from "./fs.mjs";

// --- STATE AND INITIALIZATION ---

let isEsbuildInitialized = false;

const extensions = ["", ".ts",".mts", ".tsx", ".js", ".jsx", ".mjs", ".json"];

/**
 * Initializes the esbuild WASM module internally. A flag prevents it from running more than once.
 */
async function initializeEsbuildInternal() {
    if (isEsbuildInitialized) {
        return;
    }
    try {
        await esbuild.initialize({
            worker: true,
            wasmURL: "https://unpkg.com/esbuild-wasm@0.27.2/esbuild.wasm",
        });
        isEsbuildInitialized = true;
    } catch (err) {
        // This can happen if multiple bundle calls are made in parallel before the first one completes.
        // We can safely ignore this specific error.
        if (err.message === "Cannot call `initialize` more than once") {
            isEsbuildInitialized = true;
        } else {
            // Re-throw any other initialization errors.
            throw err;
        }
    }
}

// --- CORE BUNDLING FUNCTION ---

const defaultConfig = {
    bundle: true,
    minify: false,
    format: "esm",
};

/**
 * Bundles a virtual file system in memory using esbuild.
 * Automatically initializes the esbuild WASM module on its first run.
 * @param {WebFileSystem} fs - A map representing the virtual file system.
 * @returns {Promise<Map<string, string>>} A promise resolving to a map of output files.
 */
export async function bundle_in_memory(fs, config) {
    // Ensure esbuild is initialized before proceeding.
    await initializeEsbuildInternal();

    const result = await esbuild.build({
        ...defaultConfig,
        ...config,
        write: false, // CRITICAL: Ensure esbuild returns output in memory
        plugins: [
            aliasPlugin(config.alias, config.external),
            httpPlugin(),
            fsPlugin(fs, config), // Our in-memory plugin
        ],
    });

    const decoder = new TextDecoder();
    for (const file of result.outputFiles || []) {
        console.log(file);
        await fs.writeFile(file.path, file.contents);
    }

    return result.outputFiles || [];
}

const aliasPlugin = (aliases = {}, external = []) => ({
    name: "alias-plugin",
    setup(build) {
        const aliasKeys = Object.keys(aliases);

        build.onResolve({ filter: /.*/ }, (args) => {
            if (external.includes(args.path)) {
                return { path: args.path, external: true };
            }
            for (const key of aliasKeys) {
                if (args.path === key || args.path.startsWith(key + "/")) {
                    const alias = aliases[key];
                    const replacement = aliases[key] + args.path.slice(key.length);
                    return {
                        path: replacement,
                        namespace: replacement.startsWith("http") ? "http-url" : args.namespace,
                    };
                }
            }
            return;
        });
    },
});

const httpPlugin = () => ({
    name: "http-plugin",
    setup(build) {
        build.onResolve({ filter: /^https?:\/\// }, (args) => ({
            path: args.path,
            namespace: "http-url",
        }));
        build.onResolve({ filter: /.*/, namespace: "http-url" }, (args) => ({
            path: new URL(args.path, args.importer).toString(),
            namespace: "http-url",
        }));
        build.onLoad({ filter: /.*/, namespace: "http-url" }, async (args) => {
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
            } catch (error) {
                return {
                    errors: [{ text: `Could not fetch content from ${args.path}` }],
                };
            }
        });
    },
});

function pathDirname(path) {
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
}

function normalizePath(path) {
    const parts = path.split("/");
    const result = [];
    for (const part of parts) {
        if (part === "..") {
            if (result.length > 0) result.pop();
        } else if (part !== "." && part !== "") {
            result.push(part);
        }
    }
    return result.join("/");
}

// Helper function to map a Content-Type header to a valid esbuild loader.
function getLoaderFromContentType(contentType, url) {
    // If we have no header, we can try to guess from the URL's file extension.
    if (!contentType) {
        if (url.endsWith(".css")) return "css";
        if (url.endsWith(".json")) return "json";
        // Defaults to 'js', which is a safe bet for script files without a specific type.
        return "js";
    }

    // esm.sh is smart and serves pre-compiled JavaScript for TS/JSX sources.
    // The most compatible loader is 'jsx' because it can parse plain JS as well as JSX syntax.
    if (contentType.includes("javascript") || contentType.includes("typescript")) {
        return "jsx";
    }
    if (contentType.includes("css")) {
        return "css";
    }
    if (contentType.includes("json")) {
        return "json";
    }
    if (contentType.includes("text")) {
        return "text";
    }

    // For anything else (like an HTML error page from the server), treat it as plain text
    // to avoid a bundler crash.
    return "text";
}

async function resolveFile(fs, path) {
    for (const ext of extensions) {
        const stat = await fs.stat(path + ext);
        if (stat.type === "file") {
            return path + ext;
        }
    }

    return null;
}

async function resolveDirectory(fs, dir) {
    const pkg = join(dir, "package.json");

    if (await fs.stat(pkg)) {
        try {
            const json = JSON.parse(await fs.readFile(pkg));

            const entry = json.module ?? json.main;

            if (entry) {
                const resolved =
                    (await resolveFile(fs, join(dir, entry))) ?? (await resolveDirectory(fs, join(dir, entry)));

                if (resolved) {
                    return resolved;
                }
            }
        } catch {}
    }

    return resolveFile(fs, join(dir, "index"));
}

async function resolveNodeModule(fs, specifier, importerDir) {
    const parts = specifier.split("/");

    const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];

    const subpath = specifier.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/");

    let current = importerDir;

    while (true) {
        const root = join(current, "node_modules", packageName);

        if (await fs.stat(join(root, "package.json"))) {
            let pkg;

            try {
                pkg = JSON.parse(await fs.readFile(join(root, "package.json")));
            } catch {
                return null;
            }

            if (subpath) {
                return (
                    (await resolveFile(fs, join(root, subpath))) ?? (await resolveDirectory(fs, join(root, subpath)))
                );
            }

            const entry = pkg.module ?? pkg.browser ?? pkg.main ?? "index";

            return (await resolveFile(fs, join(root, entry))) ?? (await resolveDirectory(fs, join(root, entry)));
        }

        const parent = dirname(current);

        if (parent === current) {
            break;
        }

        current = parent;
    }

    return null;
}

function dirname(path) {
    const i = path.lastIndexOf("/");

    if (i === -1) {
        return "";
    }

    return path.slice(0, i);
}

function join(...parts) {
    return normalize(parts.join("/"));
}

function normalize(path) {
    const out = [];

    for (const part of path.split("/")) {
        if (!part || part === ".") {
            continue;
        }

        if (part === "..") {
            out.pop();
        } else {
            out.push(part);
        }
    }

    return out.join("/");
}

export function fsPlugin(fs, config = {}) {
    const externals = config.external ?? [];

    return {
        name: "browser-fs",

        setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
                if (externals.includes(args.path)) {
                    return {
                        path: args.path,
                        external: true,
                    };
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
                    return {
                        errors: [
                            {
                                text: `Cannot resolve '${args.path}'`,
                            },
                        ],
                    };
                }

                return {
                    path: resolved,
                    namespace: "browser-fs",
                };
            });

            build.onLoad(
                {
                    filter: /.*/,
                    namespace: "browser-fs",
                },
                async (args) => {
                    const contents = await fs.readFile(args.path, { encoding: "utf-8" });
                    console.log(contents);
                    return {
                        contents,
                        loader: "default",
                    };
                },
            );
        },
    };
}
