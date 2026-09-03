import { createCommand } from "../services/commands.mjs";
import { WorkspaceFs } from "../effects/services.mjs";
import { nodeShimPlugin } from "../utils/node-shims.mjs";
import { getEsbuild, aliasPlugin, httpPlugin, fsPlugin } from "../utils/esbuild.mjs";
import { join } from "../utils/path.mjs";
import { Effect } from "effect";
import {
    object,
    optional,
    argument,
    string,
    option,
    passThrough,
    message,
} from "@optique/core";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

/**
 * Attach the workspace fs and a minimal `process` to `globalThis` so user code
 * (and the node shims, which read `globalThis.fs` lazily) can use them.
 * Globals persist between runs by design.
 *
 * @param {import("../services/fs.mjs").WebFileSystem} fs
 * @param {string} entry
 * @param {string[]} scriptArgs
 */
function installGlobals(fs, entry, scriptArgs) {
    globalThis.fs = fs;

    /** @type {any} */ (globalThis.process) ??= {};
    const proc = /** @type {any} */ (globalThis.process);
    proc.argv = [proc.argv?.[0] ?? "run", entry, ...scriptArgs];
    proc.env ??= {};
    proc.cwd = () => fs.cwd;
    proc.chdir = (d) => { fs.cwd = d; };
    proc.platform = "browser";
    proc.exit = (code = 0) => {
        throw new Error(`process.exit(${code})`);
    };
}

// ---------------------------------------------------------------------------
// Console piping
// ---------------------------------------------------------------------------

/**
 * @param {unknown} v
 * @returns {string}
 */
function formatValue(v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || v.message;
    try {
        return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() + "n" : x)) ?? String(v);
    } catch {
        return String(v);
    }
}

/**
 * Run `fn` with the global console mirrored to the terminal (still forwarded
 * to devtools). Restored even if `fn` throws — and, for async `fn` (e.g. a
 * dynamic import), after the returned promise settles, since module
 * evaluation happens asynchronously.
 *
 * @template A
 * @param {import("../types/terminal.d.ts").Terminal} term
 * @param {() => A} fn
 * @returns {A}
 */
function withPipedConsole(term, fn) {
    const levels = ["log", "info", "warn", "error", "debug", "trace"];
    const orig = /** @type {Record<string, any>} */ ({});
    for (const level of levels) orig[level] = console[level].bind(console);
    for (const level of levels) {
        console[level] = (...args) => {
            const text = args.map(formatValue).join(" ");
            if (level === "error") term.error(text);
            else if (level === "warn") term.log(`⚠ ${text}`);
            else term.log(text);
            orig[level](...args);
        };
    }
    const restore = () => {
        for (const level of levels) console[level] = orig[level];
    };
    let result;
    try {
        result = fn();
    } catch (e) {
        restore();
        throw e;
    }
    if (result && typeof /** @type {any} */ (result).then === "function") {
        return /** @type {any} */ (
            /** @type {any} */ (result).finally(restore)
        );
    }
    restore();
    return result;
}

// ---------------------------------------------------------------------------
// Worker execution
// ---------------------------------------------------------------------------

/**
 * Prelude injected before the user bundle in worker mode. It is a module
 * worker, so top-level await is available: it waits for the main thread to
 * transfer the workspace root directory handle, builds an fs bridge over it,
 * installs `self.fs` / `self.process`, and pipes console + errors back to the
 * main thread before evaluating the user bundle.
 */
const WORKER_PRELUDE = `
const __send = (m) => self.postMessage(m);
const __fmt = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || v.message;
    try { return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() + "n" : x)) ?? String(v); }
    catch { return String(v); }
};
for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
    console[level] = (...args) => __send({ __run: true, level, text: args.map(__fmt).join(" ") });
}
self.addEventListener("unhandledrejection", (e) =>
    __send({ __run: true, level: "error", text: "Unhandled rejection: " + __fmt(e.reason) }));
self.addEventListener("error", (e) => {
    const err = e.error;
    const where = e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ":" + e.colno + ")" : "";
    const text = (err && (err.stack || err.message)) || ((e.message || "Worker error") + where);
    __send({ __run: true, level: "error", text: "Worker error" + where + ": " + text });
});

const __argv = __RUN_ARGV__;

// Wait for the workspace root handle from the main thread.
const __root = await new Promise((resolve, reject) => {
    const onMsg = (e) => {
        if (e.data && e.data.__runfs) {
            self.removeEventListener("message", onMsg);
            if (e.data.__runfsError) reject(new Error(e.data.__runfsError));
            else resolve(e.data.__runfs);
        }
    };
    self.addEventListener("message", onMsg);
    __send({ __runReady: true });
});

function __makeFs(root) {
    async function __dirFor(path, create) {
        const parts = path.split("/").filter(Boolean);
        let dir = root;
        for (let i = 0; i < parts.length - 1; i++) {
            dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
        }
        return { dir, name: parts[parts.length - 1] };
    }
    async function __fileHandle(path, create) {
        const { dir, name } = await __dirFor(path, create);
        if (name === undefined) throw new Error("EISDIR: " + path);
        return dir.getFileHandle(name, { create: !!create });
    }
    return {
        get cwd() { return "/"; },
        promises: {
            readFile: async (path) => {
                const fh = await __fileHandle(path, false);
                return (await fh.getFile()).text();
            },
            writeFile: async (path, data) => {
                const fh = await __fileHandle(path, true);
                const writable = await fh.createWritable();
                await writable.write(typeof data === "string" ? data : data.buffer ?? data);
                await writable.close();
            },
            readdir: async (path) => {
                const parts = path.split("/").filter(Boolean);
                let dir = root;
                for (const part of parts) dir = await dir.getDirectoryHandle(part);
                const out = [];
                for await (const [name, handle] of dir.entries()) {
                    out.push(handle.kind === "directory" ? name + "/" : name);
                }
                return out;
            },
            stat: async (path) => {
                const { dir, name } = await __dirFor(path, false);
                if (name === undefined) return { type: "directory", size: 0, isFile: () => false, isDirectory: () => true };
                try {
                    const fh = await dir.getFileHandle(name);
                    const f = await fh.getFile();
                    return { type: "file", size: f.size, mtime: new Date(f.lastModified), isFile: () => true, isDirectory: () => false };
                } catch {
                    await dir.getDirectoryHandle(name);
                    return { type: "directory", size: 0, isFile: () => false, isDirectory: () => true };
                }
            },
            mkdir: async (path) => {
                const { dir, name } = await __dirFor(path, true);
                if (name !== undefined) await dir.getDirectoryHandle(name, { create: true });
            },
            unlink: async (path) => {
                const { dir, name } = await __dirFor(path, false);
                if (name === undefined) throw new Error("EISDIR: " + path);
                await dir.removeEntry(name);
            },
        },
    };
}
self.fs = __makeFs(__root);
self.process = {
    env: {},
    argv: __argv,
    platform: "browser",
    cwd: () => "/",
    exit(code = 0) {
        throw new Error("process.exit(" + code + ")");
    },
};
`;

/**
 * Build a complete worker module source: prelude + user bundle, wrapped so
 * completion and errors are signalled back to the main thread.
 *
 * @param {string} bundleCode IIFE bundle (self-contained, no imports).
 * @param {string[]} argv
 */
export function buildWorkerSource(bundleCode, argv) {
    return (
        WORKER_PRELUDE.replace("__RUN_ARGV__", JSON.stringify(argv)) +
        `
try {
    await (async () => {
${bundleCode}
    })();
    __send({ __runDone: true });
} catch (e) {
    __send({ __run: true, level: "error", text: (e && e.stack) || String(e) });
    __send({ __runDone: true });
}
`
    );
}

/**
 * Run a worker module source, streaming console output to the terminal.
 * The workspace root handle is transferred so the worker can build its own
 * fs (FileSystemDirectoryHandle is structured-cloneable).
 *
 * @param {string} source
 * @param {import("../services/fs.mjs").WebFileSystem} fs
 * @param {import("../types/terminal.d.ts").Terminal} term
 * @returns {Promise<void>}
 */
function runInWorker(source, fs, term) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        /** @type {Worker | null} */
        let worker = null;
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            worker?.terminate();
            URL.revokeObjectURL(url);
            fn(value);
        };

        try {
            worker = new Worker(url, { type: "module" });
        } catch (e) {
            URL.revokeObjectURL(url);
            throw new Error(
                `Could not start worker: ${/** @type {Error} */ (e).message}. This may be blocked by the page's Content-Security-Policy (worker-src).`,
            );
        }

        worker.addEventListener("message", (e) => {
            const d = e.data || {};
            if (d.__runReady) {
                const handle = /** @type {any} */ (fs).rootHandle;
                worker?.postMessage(
                    handle
                        ? { __runfs: handle }
                        : { __runfsError: "No workspace root handle available" },
                );
            } else if (d.__run) {
                if (d.level === "error") term.error(d.text);
                else if (d.level === "warn") term.log(`⚠ ${d.text}`);
                else term.log(d.text);
            } else if (d.__runDone) {
                finish(resolve, undefined);
            }
        });
        worker.addEventListener("error", (e) => {
            const err = /** @type {any} */ (e).error;
            const where = /** @type {any} */ (e).filename
                ? ` (${String(/** @type {any} */ (e).filename).split("/").pop()}:${/** @type {any} */ (e).lineno}:${/** @type {any} */ (e).colno})`
                : "";
            finish(
                reject,
                new Error(
                    `Worker error${where}: ${err?.stack || err?.message || e.message || "script failed to load"}`,
                ),
            );
        });
        worker.addEventListener("messageerror", () =>
            finish(reject, new Error("Worker message deserialization failed")),
        );
    });
}

// ---------------------------------------------------------------------------
// CSP hint
// ---------------------------------------------------------------------------

/**
 * @param {unknown} cause
 * @param {boolean} evalMode
 * @returns {string}
 */
function describeRunError(cause, evalMode) {
    const msg =
        cause instanceof Error
            ? cause.message
            : /** @type {any} */ (cause)?.message ?? String(cause);
    const lines = [msg || "unknown error"];
    if (!evalMode && /import|blob|CSP|Content.Secur|eval/i.test(msg)) {
        lines.push(
            `hint: this may be blocked by the page's Content-Security-Policy. Try --eval (new Function/eval path) to test, or --worker (needs worker-src blob:).`,
        );
    }
    if (evalMode && /import|export|Unexpected token/i.test(msg)) {
        lines.push(
            `hint: eval/new Function cannot evaluate ESM import/export statements. Try without --eval (blob import), or use --bundle --eval which emits a self-contained IIFE.`,
        );
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const runCommand = createCommand({
    name: "run",
    parser: object({
        entry: argument(string({ metavar: "FILE" }), {
            description: message`Script file to execute (relative to the current directory)`,
        }),
        raw: optional(option("--raw", {
            description: message`Run the file text directly via blob import — no bundling, no node_modules resolution`,
        })),
        bundle: optional(option("--bundle", {
            description: message`Bundle with esbuild first (default) — imports, node_modules, TS/JSX all work`,
        })),
        worker: optional(option("--worker", {
            description: message`Execute in a dedicated module worker (needs worker-src blob:)`,
        })),
        main: optional(option("--main", {
            description: message`Execute on the main thread (default)`,
        })),
        evalMode: optional(option("--eval", {
            description: message`Execute via eval/new Function instead of blob import — use to test CSP behaviour`,
        })),
        scriptArgs: passThrough({ format: "greedy" }),
    }),
    aliases: ["r"],
    description: message`Run a script file from the workspace (bundle or raw, main thread or worker)`,
    usage: message`run <file> [--raw|--bundle] [--worker|--main] [--eval] [-- script args...]`,
    brief: message`Run a script file from the workspace`,
    timeoutSeconds: 300,

    /**
     * @param {{
     *   entry: string,
     *   raw?: boolean,
     *   bundle?: boolean,
     *   worker?: boolean,
     *   main?: boolean,
     *   evalMode?: boolean,
     *   scriptArgs?: string[],
     * }} parsed
     * @param {import("../types/terminal.d.ts").Terminal} term
     * @returns {Effect.Effect<undefined, Error>}
     */
    executeEffect: (parsed, term) =>
        /** @type {Effect.Effect<undefined, Error>} */ (
            Effect.gen(function* () {
                const fs = yield* WorkspaceFs;

                const mode = parsed.raw ? "raw" : "bundle";
                const thread = parsed.worker ? "worker" : "main";
                const evalMode = Boolean(parsed.evalMode);
                const scriptArgs = (parsed.scriptArgs ?? []).filter((a) => a !== "--");
                const argv = ["run", parsed.entry, ...scriptArgs];

                // Workers run prebundled IIFE code — eval path only applies on
                // the main thread.
                if (evalMode && thread === "worker") {
                    term.log("note: --eval only applies to main-thread execution; running worker normally");
                }

                installGlobals(fs, parsed.entry, scriptArgs);

                // Absolute entry (workspace-root relative) for esbuild; fs ops
                // use the raw path so relative entries resolve against fs.cwd.
                // join() strips the leading slash, so re-add it.
                const absEntry =
                    "/" + join(parsed.entry.startsWith("/") ? "" : fs.cwd || "", parsed.entry);

                const started = performance.now();

                const run = Effect.tryPromise({
                    try: async () => {
                        if (thread === "worker") {
                            if (mode === "raw") {
                                throw new Error(
                                    "--raw is not supported with --worker (workers always run a bundled, self-contained script)",
                                );
                            }
                            if (evalMode) {
                                throw new Error(
                                    "--eval is not supported with --worker (worker code runs as a module)",
                                );
                            }
                            const esb = await getEsbuild();
                            const result = await esb.build({
                                entryPoints: [absEntry],
                                bundle: true,
                                write: false,
                                format: "iife",
                                target: "es2022",
                                plugins: [nodeShimPlugin(), aliasPlugin(), httpPlugin(), fsPlugin(fs)],
                            });
                            if (!result.outputFiles?.length) {
                                throw new Error("esbuild produced no output");
                            }
                            const bundle = result.outputFiles[0].text;
                            await runInWorker(buildWorkerSource(bundle, argv), fs, term);
                            return;
                        }

                        let /** @type {string} */ code;

                        if (mode === "raw") {
                            code = /** @type {string} */ (
                                await fs.readFile(parsed.entry, { encoding: "utf-8" })
                            );
                        } else {
                            const esb = await getEsbuild();
                            const result = await esb.build({
                                entryPoints: [absEntry],
                                bundle: true,
                                write: false,
                                // eval cannot handle top-level import/export —
                                // emit a self-contained IIFE for the eval path.
                                format: evalMode ? "iife" : "esm",
                                target: "es2022",
                                plugins: [nodeShimPlugin(), aliasPlugin(), httpPlugin(), fsPlugin(fs)],
                            });
                            if (!result.outputFiles?.length) {
                                throw new Error("esbuild produced no output");
                            }
                            code = result.outputFiles[0].text;
                        }

                        if (evalMode) {
                            // Indirect eval runs in global scope — tests CSP
                            // script-src 'unsafe-eval' instead of blob: imports.
                            withPipedConsole(term, () => (0, eval)(code));
                        } else {
                            const blobUrl = URL.createObjectURL(
                                new Blob([code], { type: "text/javascript" }),
                            );
                            try {
                                await withPipedConsole(term, () => import(/* @vite-ignore */ blobUrl));
                            } finally {
                                URL.revokeObjectURL(blobUrl);
                            }
                        }
                    },
                    catch: (cause) => ({ cause }),
                }).pipe(
                    Effect.mapError((e) => new Error(describeRunError(e.cause, evalMode))),
                );

                yield* run;

                const ms = (performance.now() - started).toFixed(0);
                term.log(`✓ ${parsed.entry} [${mode}/${thread}${evalMode ? "/eval" : ""}] (${ms}ms)`);
            })
        ),
});
