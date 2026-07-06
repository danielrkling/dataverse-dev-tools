import { WebFileSystem } from "../fs.mjs";
import { dirname, join, EXTENSIONS } from "../utils/path.mjs";
import { readJSON } from "../utils/json.mjs";
import {
    object,
    optional,
    flag,
    option,
    string,
    passThrough,
    message,
    argument,
    multiple,
    map,
    choice,
} from "@optique/core";
import { createCommand } from "../terminal.mjs";
import { aliasPlugin, fsPlugin, getEsbuild, httpPlugin } from "../utils/esbuild.mjs";

// --- CLI ARG PARSING ---

const esbuildParser = object({
    entryPoints: map(
        multiple(argument(string({ metavar: "FILES" }), { description: message`Comma-separated entry points` })),
        (v) => [...v],
    ),
    bundle: optional(option("--bundle", { description: message`Bundle modules` })),
    outdir: optional(option("--outdir", string({ metavar: "DIR" }), { description: message`Output directory` })),
    watch: optional(option("--watch", { description: message`Watch` })),
    format: optional(
        option("--format", choice(["iife", "cjs", "esm"], { metavar: "FORMAT" }), {
            description: message`Module format (esm, cjs, iife)`,
        }),
    ),
    metafile: optional(option("--metafile", { description: message`Metafile` })),
    platform: optional(
        option("--platform", choice(["browser", "node", "neutral"], { metavar: "PLATFORM" }), {
            description: message`Platform (browser, node, neutral)`,
        }),
    ),
    tsconfig: optional(
        option("--tsconfig", string({ metavar: "TSCONFIG" }), {
            description: message`Merge options from tsconfig.json`,
        }),
    ),
    sourcemap: optional(
        option("--sourcemap", choice(["linked", "external", "inline", "both"], { metavar: "MODE" }), {
            description: message`Sourcemap mode (inline, external, both)`,
        }),
    ),
    target: optional(
        option("--target", string({ metavar: "TARGET" }), {
            description: message`Language target (es2020, esnext, etc.)`,
        }),
    ),
    // external: multiple(
    //     option("--external", string({ metavar: "PKGS" }), { description: message`Comma-separated external packages` }),
    // ),
    define: map(
        multiple(
            option("--define", string({ metavar: "KEY=VALUE" }), { description: message`Define a global constant` }),
        ),
        (v) => Object.fromEntries(v.map((e) => e.split("="))),
    ),
    // loader: multiple(
    //     option("--loader", string({ metavar: "EXT=LOADER" }), { description: message`Set loader for file extension` }),
    // ),
    // outExtension: optional(
    //     option("--out-extension", string({ metavar: "EXT=EXT" }), {
    //         description: message`Output file extension mapping`,
    //     }),
    // ),
    // alias: optional(option("--alias", string({ metavar: "FROM=TO" }), { description: message`Path alias` })),
    // minify: optional(flag("--minify", { description: message`Minify output` })),
    // noMinify: optional(flag("--no-minify", { description: message`Disable minification` })),

    // splitting: optional(flag("--splitting", { description: message`Enable code splitting` })),
    // noSplitting: optional(flag("--no-splitting", { description: message`Disable code splitting` })),
    //
    // rest: passThrough(),
});



// --- COMMAND ---

export default createCommand({
    name: "esbuild",
    parser: esbuildParser,
    aliases: ["build"],
    description: message`Bundle files using esbuild`,
    usage: message`esbuild [options]`,
    brief: message`Bundle files using esbuild`,
    execute: async (parsed, terminal) => {
        const fileConfig = (await readJSON(terminal.fs, "esbuild.config.json")) || {};
        const { watch, ...config } = {
            ...fileConfig,
            ...parsed,
            plugins: [aliasPlugin(), httpPlugin(), fsPlugin(terminal.fs)],
        };

        const esbuild = await getEsbuild();

        if (watch) {
            const context = await esbuild.context({ ...config, metafile: true });
            const result = await context.rebuild();
            for (const output of result.outputFiles ?? []) {
                terminal.fs.writeFile(output.path, output.contents);
            }
            let filesToWatch = Object.keys(result.metafile?.inputs ?? {}).map((v) => v.split(":")[1]);
            terminal.addEventListener("fs:modified", async (e) => {
                //@ts-expect-error
                const path = e.detail.path;

                if (filesToWatch.includes(path)) {
                    const result = await context.rebuild();
                    filesToWatch = Object.keys(result.metafile?.inputs ?? {}).map((v) => v.split(":")[1]);
                    for (const output of result.outputFiles ?? []) {
                        terminal.fs.writeFile(output.path, output.contents);
                    }
                }
            });
        } else {
            const result = await esbuild.build({ ...config, plugins: [fsPlugin(terminal.fs)] });
            for (const output of result.outputFiles ?? []) {
                terminal.fs.writeFile(output.path, output.contents);
            }
        }
    },

    // init: async ({ fs, terminal }) => {
    //     const config = await readJSON(fs, "esbuild.config.json");
    //     if (!config) return;

    //     const trackedFiles = new Set();
    //     /** @type {string[]} */
    //     let watchDirs = [];

    //     function computeWatchDirs() {
    //         const dirs = new Set();
    //         for (const file of trackedFiles) {
    //             let dir = dirname(file);
    //             while (dir) {
    //                 dirs.add(dir);
    //                 const parent = dirname(dir);
    //                 if (parent === dir) break;
    //                 dir = parent;
    //             }
    //         }
    //         return [...dirs].sort((a, b) => b.length - a.length);
    //     }

    //     // Build once to warm the context
    //     try {
    //         const files = await bundle_in_memory(fs, config, true, trackedFiles);
    //         if (files.length > 0) terminal.log(`esbuild built: ${files.map((f) => f.path).join(", ")}`);
    //         watchDirs = computeWatchDirs();
    //     } catch (e) {
    //         terminal.info(`esbuild: ${e.message}`);
    //     }

    //     const unsub = pm.on("fs:change", ({ path, type }) => {
    //         if (type !== "modified") return;
    //         if (watchDirs.length > 0 && !watchDirs.some((dir) => path.startsWith(dir))) return;

    //         bundle_in_memory(fs, config, true, trackedFiles)
    //             .then((files) => {
    //                 term.log(`esbuild rebuilt: ${files.map((f) => f.path).join(", ")}`);
    //                 watchDirs = computeWatchDirs();
    //                 pm.emit("build:complete", { files, builder: "esbuild" });
    //             })
    //             .catch((e) => {
    //                 term.error(`esbuild rebuild failed: ${e.message}`);
    //                 pm.emit("build:error", { error: e.message, builder: "esbuild" });
    //             });
    //     });

    //     return unsub;
    // },
});
