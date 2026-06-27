export const extensions = ["", ".ts",".mts", ".tsx", ".js", ".jsx", ".mjs", ".json"];

/**
 * @param {string} path
 * @returns {string}
 */
export function pathDirname(path) {
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
}

/**
 * @param {string} path
 * @returns {string}
 */
export function dirname(path) {
    const i = path.lastIndexOf("/");
    if (i === -1) return "";
    return path.slice(0, i);
}

/**
 * @param {...string} parts
 * @returns {string}
 */
export function join(...parts) {
    return normalize(parts.join("/"));
}

/**
 * @param {string} path
 * @returns {string}
 */
export function normalize(path) {
    const out = [];
    for (const part of path.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") out.pop();
        else out.push(part);
    }
    return out.join("/");
}

/**
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
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

/**
 * Maps a Content-Type header or URL extension to a valid esbuild loader.
 * @param {string} contentType
 * @param {string} url
 * @returns {string}
 */
export function getLoaderFromContentType(contentType, url) {
    if (!contentType) {
        if (url.endsWith(".css")) return "css";
        if (url.endsWith(".json")) return "json";
        return "js";
    }

    if (contentType.includes("javascript") || contentType.includes("typescript")) {
        return "jsx";
    }
    if (contentType.includes("css")) return "css";
    if (contentType.includes("json")) return "json";
    if (contentType.includes("text")) return "text";

    return "text";
}

/**
 * @param {import('./fs.mjs').WebFileSystem} fs
 * @param {string} path
 * @returns {Promise<string|null>}
 */
export async function resolveFile(fs, path) {
    for (const ext of extensions) {
        const stat = await fs.stat(path + ext);
        if (stat.type === "file") {
            return path + ext;
        }
    }
    return null;
}

/**
 * @param {import('./fs.mjs').WebFileSystem} fs
 * @param {string} dir
 * @returns {Promise<string|null>}
 */
export async function resolveDirectory(fs, dir) {
    const pkg = join(dir, "package.json");

    if (await fs.stat(pkg)) {
        try {
            const json = JSON.parse(/** @type {string} */ (await fs.readFile(pkg, { encoding: 'utf8' })));

            const entry = json.module ?? json.main;

            if (entry) {
                const resolved =
                    (await resolveFile(fs, join(dir, entry))) ?? (await resolveDirectory(fs, join(dir, entry)));

                if (resolved) return resolved;
            }
        } catch {}
    }

    return resolveFile(fs, join(dir, "index"));
}

/**
 * @param {import('./fs.mjs').WebFileSystem} fs
 * @param {string} specifier
 * @param {string} importerDir
 * @returns {Promise<string|null>}
 */
export async function resolveNodeModule(fs, specifier, importerDir) {
    const parts = specifier.split("/");
    const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const subpath = specifier.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/");
    let current = importerDir;

    while (true) {
        const root = join(current, "node_modules", packageName);

        if (await fs.stat(join(root, "package.json"))) {
            let pkg;
            try {
                pkg = JSON.parse(/** @type {string} */ (await fs.readFile(join(root, "package.json"), { encoding: 'utf8' })));
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
        if (parent === current) break;
        current = parent;
    }

    return null;
}

/**
 * @param {import('./fs.mjs').WebFileSystem} fs
 * @param {Object} [config]
 * @param {string[]} [config.external]
 * @returns {{ name: string, setup: Function }}
 */
export function fsPlugin(fs, config = {}) {
    const externals = /** @type {string[]} */ (config.external) ?? [];

    return {
        name: "browser-fs",

        /** @param {any} build */
        setup(build) {
            build.onResolve({ filter: /.*/ }, async (/** @type {any} */ args) => {
                if (externals.includes(args.path)) {
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

            build.onLoad({ filter: /.*/, namespace: "browser-fs" }, async (/** @type {any} */ args) => {
                const raw = await fs.readFile(args.path, { encoding: "utf-8" });
                const contents = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
                return { contents, loader: "default" };
            });
        },
    };
}
