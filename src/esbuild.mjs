// @ts-ignore - esbuild-wasm is loaded from CDN, no local types available
import * as esbuild from "https://unpkg.com/esbuild-wasm@0.27.2/esm/browser.min.js";
import { WebFileSystem } from "./fs.mjs";
import {
    extensions,
    pathDirname,
    normalizePath,
    getLoaderFromContentType,
    dirname,
    join,
    normalize,
    resolveFile,
    resolveDirectory,
    resolveNodeModule,
    fsPlugin,
} from "./esbuild-utils.mjs";

// --- STATE AND INITIALIZATION ---

let isEsbuildInitialized = false;

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
 * @param {WebFileSystem} fs
 * @param {import('esbuild').BuildOptions} config
 * @returns {Promise<import('esbuild').OutputFile[]>}
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

/**
 * @param {Record<string, string>} aliases
 * @param {string[]} external
 * @returns {import('esbuild').Plugin}
 */
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

/** @returns {import('esbuild').Plugin} */
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


