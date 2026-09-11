import {
  argument,
  map,
  message,
  multiple,
  negatableFlag,
  object,
  option,
  optional,
  string,
  withDefault,
} from "@optique/core";
import picomatch from "picomatch";
import * as z from "zod";
import { Effect } from "effect";
import { createWatchPipeline } from "../effects/watch-pipeline.mjs";
import { DataverseService, isValidWebResource } from "../effects/dataverse-service.mjs";
import { TerminalUi } from "../effects/terminal-ui.mjs";
import { WorkspaceFs, commandLayers } from "../effects/services.mjs";
import { createCommand, createStopWatchButton } from "../services/commands.mjs";
import {bus} from "../services/bus.mjs"

export const dataverseConfigSchema = z.object({
    prefix: z.string(),
    solution: z.string().optional(),
    files: z.array(z.string()).optional(),
    preview: z.string().optional(),
    refresh: z.string().optional(),
});

/**
 * Read and validate a dataverse config file against the WorkspaceFs
 * service (used by upload and preview).
 * @param {import("../types/services.d.ts").WorkspaceFsService} fs
 * @param {string} path
 * @returns {Effect.Effect<import("zod").infer<typeof dataverseConfigSchema>, Error>}
 */
function readConfigEffect(fs, path) {
    return Effect.gen(function* () {
        const raw = yield* Effect.tryPromise({
            try: async () => JSON.parse(/** @type {string} */ (await fs.readFile(path, { encoding: "utf-8" }))),
            catch: (/** @type {any} */ e) => new Error(`Error reading ${path}:\n${e instanceof Error ? e.message : e}`),
        });
        return yield* Effect.try({
            try: () => validateConfig(raw, path),
            catch: (/** @type {any} */ e) => e,
        });
    });
}

/**
 * @param {unknown} raw
 * @param {string} path
 * @returns {import("zod").infer<typeof dataverseConfigSchema>}
 */
function validateConfig(raw, path) {
    const result = dataverseConfigSchema.safeParse(raw);
    if (!result.success) {
        throw new Error(`Error parsing ${path}:\n${z.prettifyError(result.error)}`);
    }
    return result.data;
}

const uploadParser = object({    prefix: optional(
        option("-p", "--prefix", string({ metavar: "PREFIX" }), {
            description: message`Prefix for WebResource. Must contain an underscore`,
        }),
    ),
    solution: optional(
        option("-s", "--solution", string({ metavar: "SOLUTION" }), {
            description: message`Solution name to upload to`,
        }),
    ),
    files: map(
        multiple(
            argument(string({ metavar: "FILES" }), {
                description: message`Files or glob patterns to upload`,
            }),
        ),
        (v) => (v.length ? v : undefined),
    ),
    config: withDefault(
        option("-c", "--config", string({ metavar: "FILE" }), {
            description: message`Path to config file (default: dataverse.config.json)`,
        }),
        "dataverse.config.json",
    ),
    watch: option("-w", "--watch", {
        description: message`Watch for changes and auto-upload`,
    }),
    publish: withDefault(
        negatableFlag({
            positive: ["--publish", "--publish=true"],
            negative: ["--no-publish", "--upload-only", "--publish=false"],
        }),
        true,
    ),
    init: optional(
        option("--init", {
            description: message`Scaffold the default config file and exit`,
        }),
    ),
});

export const uploadCommand = createCommand({
    name: "upload",
    parser: uploadParser,
    aliases: ["ul"],
    description: message`Upload web resources to Dataverse`,
    usage: message`upload init | upload [files..] [options]`,
    brief: message`Upload web resources to Dataverse`,
    timeoutSeconds: 600, // uploads are batched with retries — don't cut at 60s
    executeEffect: (parsed, term) => {
        return /** @type {Effect.Effect<undefined, Error>} */ (
            Effect.gen(function* () {
                const fs = yield* WorkspaceFs;

                // --- `upload --init`: scaffold the default config file ---
                if (parsed.init) {
                    const configPath = parsed.config || "dataverse.config.json";
                    if (yield* Effect.tryPromise({ try: () => fs.exists(configPath), catch: () => false })) {
                        term.error(`${configPath} already exists — remove it first if you want to re-scaffold.`);
                        return undefined;
                    }
                    const scaffold = {
                        prefix: "new_",
                        files: ["**/*.js", "**/*.mjs", "**/*.html", "**/*.css"],
                        solution:"",
                        preview:""
                    };
                    yield* Effect.tryPromise({
                        try: () => fs.writeFile(configPath, `${JSON.stringify(scaffold, null, 2)}\n`, "utf8"),
                        catch: (cause) => new Error(`write ${configPath}: ${/** @type {any} */ (cause)?.message ?? cause}`),
                    });
                    term.success(
                        `Wrote ${configPath} — set prefix (must contain an underscore) and optionally solution.`,
                    );
                    return undefined;
                }

                let { files, prefix, solution } = parsed;

                if (!(files && prefix && solution)) {
                    const configFile = yield* readConfigEffect(fs, parsed.config || "dataverse.config.json");
                    files ??= configFile.files ?? [];
                    prefix ??= configFile.prefix;
                    solution ??= configFile.solution;
                }

                const isMatch = picomatch(files ?? []);
                const entries = yield* Effect.tryPromise({
                    try: () => fs.getFilesFromDirectory("", isMatch),
                    catch: (cause) => new Error(`collecting files: ${/** @type {any} */ (cause)?.message ?? cause}`),
                });

                // Errors surface through the registry (single friendly line).
                yield* uploadFilesEffect(entries, { files, prefix, solution, publish: parsed.publish });

                if (parsed.watch) {
                const ui = yield* TerminalUi;
                const watcher = ui.startWatcher("dataverse-watch", "dataverse --watch");

            /**
             * Upload a single changed file as an Effect. Content is read
             * *inside* the pipeline (after debouncing), so the latest
             * version is uploaded — not a snapshot from the first event.
             * Serialized by the pipeline's semaphore; the DataverseService
             * handles retries/timeouts internally.
             * @param {{ path: string, type: string }} e
             */
            const uploadEffect = (e) =>
                Effect.gen(function* () {
                    if (e.type === "deleted") return;
                    watcher.set("building", e.path);
                    const content = yield* Effect.tryPromise({
                        try: () => fs.readFile(e.path, { encoding: "utf8" }),                        catch: (cause) => ({
                            _tag: "ReadError",
                            message: `Could not read ${e.path}`,
                            cause,
                        }),
                    });
                    yield* uploadFilesEffect([[e.path, /** @type {string} */ (content)]], {
                        files,
                        prefix,
                        solution,
                        publish: parsed.publish,
                    });
                    watcher.set("ok", e.path);
                }).pipe(
                    Effect.tapError(() => Effect.sync(() => watcher.set("error", e.path))),
                    Effect.withSpan("dataverse.watch-upload", { attributes: { path: e.path } }),
                );

            const pipeline = createWatchPipeline({
                name: "dataverse-upload",
                debounceMs: 300,
                match: isMatch,
                handler: uploadEffect,
                term,
                layer: commandLayers(term),
            });

            const unsub = bus.on("fs:changed", (/** @type {CustomEvent} */ e) => {
                pipeline.push(/** @type {any} */ (e).detail);
            });
            createStopWatchButton({ term, pipeline, unsub, onStopped: () => watcher.remove() });
        }

        /**
         * Upload (and optionally publish) files as an Effect using the
         * DataverseService. DOM status updates happen inline; each request
         * is retried/timed out/logged by the service.
         *
         * Requirements (DataverseService, TerminalUi) are provided by the
         * registry's commandLayers — or the watch pipeline's layer — never
         * inline, so there is exactly one layer graph.
         *
         * @param {[string,string][]} files
         * @param {{ files: any, prefix: string, solution?: string, publish: boolean }} run
         * @returns {Effect.Effect<void, Error, any>}
         */
        function uploadFilesEffect(files, run) {
            const runId = Math.random().toString(36).slice(2, 7);
            const validFiles = files.map((v) => [`${run.prefix}/${v[0]}`, v[1]]).filter((v) => isValidWebResource(v[0]));
            const filenames = validFiles.map((v) => v[0]);
            if (!validFiles.length) return Effect.void;

            const describeError = (/** @type {any} */ err) =>
                `upload failed: ${err?._tag} ${err?.message ?? err?.path ?? err?.name ?? ""}`.trimEnd();

            // The upload/publish body. The failure log lives INSIDE this
            // region so it carries span context and reaches the terminal
            // logger (error paths restore FiberRefs captured at the failure
            // origin, so spans/annotations must be ambient at that point).
            const body = Effect.gen(function* () {
                const api = yield* DataverseService;
                const ui = yield* TerminalUi;
                const group = yield* Effect.sync(() => ui.startGroup("Uploading:", filenames.join(",")));

                // Concurrency 3: parallel but bounded — no request stampede.
                const wrs = yield* Effect.forEach(
                    validFiles,
                    ([name, content]) =>
                        api.upload(name, content, run.solution).pipe(
                            Effect.tap(() => Effect.sync(() => group.log(`✓ uploaded ${name}`))),
                        ),
                    { concurrency: 3 },
                ).pipe(
                    // Errors here are service failures — recolor the line.
                    Effect.tapError(() => Effect.sync(() => { group.set("Failed:", "", "#f14c4c"); group.fail(); })),
                );
                group.set("Uploaded:", "", "#4fc1ff");
                group.detail(`${filenames.length} file(s)`);
                bus.emit("dataverse:uploaded", { files: run.files });
                if (run.publish) {
                    group.set("Publishing", "", "#e2c08d");
                    yield* api.publish(wrs, run.solution).pipe(
                        Effect.tapError(() => Effect.sync(() => { group.set("Failed:", "", "#f14c4c"); group.fail(); })),
                    );
                    group.set("Published:", "", "#4ec9b0");
                    group.detail(`${filenames.length} file(s), published`);
                    group.log(`✓ published ${wrs.length} webresource(s)`);
                    bus.emit("dataverse:published", { files: run.files });
                }
            });

            return body.pipe(
                Effect.withSpan("dataverse.uploadFiles", {
                    attributes: { runId, count: validFiles.length, publish: run.publish },
                }),
                // Convert to a plain Error so the registry's error path can
                // display it — the single error report (no duplicate logging).
                Effect.mapError((err) => new Error(describeError(err))),
            );
        }

            return undefined;
            })
        );
    },
});

export const previewCommand = createCommand({
    name: "preview",
    parser: object({
        preview: optional(
            argument(string({ metavar: "PATH" }), {
                description: message`Web resource path to preview`,
            }),
        ),
        onUpload: option("--upload", "-u"),
        onPublish: option("--publish", "-p"),
        config: withDefault(
            option("-c", "--config", string({ metavar: "FILE" }), {
                description: message`Path to config file (default: dataverse.config.json)`,
            }),
            "dataverse.config.json",
        ),
    }),
    aliases: ["pv"],
    description: message`Preview a web resource in a new tab`,
    usage: message`preview [path]`,
    brief: message`Preview a web resource in a new tab`,
    executeEffect: (parsed, term) =>
        Effect.gen(function* () {
            let { preview } = parsed;

            if (!preview) {
                const fs = yield* WorkspaceFs;
                preview = (yield* readConfigEffect(fs, parsed.config)).preview;
            }

            if (!preview) return "Could not determine preview path.";
            const url = `${location.origin}/WebResources/${preview}`;
            const win = window.open(url);
            if (!win) return `Blocked popup — could not open ${url}`;

            /** Reload the preview window whenever one of these events fires. */
            const reloadOn = (/** @type {"dataverse:uploaded" | "dataverse:published"} */ eventName) => {
                const unsub = bus.on(eventName, () => {
                    try {
                        win.location.reload();
                    } catch {
                        unsub();
                    }
                });
            };
            if (parsed.onUpload) reloadOn("dataverse:uploaded");
            if (parsed.onPublish) reloadOn("dataverse:published");

            return `Opening ${url}`;
        }).pipe(Effect.withSpan("dataverse.preview"), Effect.withLogSpan("dataverse.preview")),
});

export const cacheCommand = createCommand({
    name: "cache",
    parser: object({
        path: optional(
            argument(string({ metavar: "PATH" }), {
                description: message`Web resource path to create cached url for`,
            }),
        )
    }),
    description: message`Get the cached URL of a web resource`,
    usage: message`cache [path]`,
    brief: message`Get the cached URL of a web resource`,
    executeEffect: (parsed, term) =>
        Effect.sync(() => {
            const { path } = parsed;

            // 1. Get the current date at midnight UTC to keep the token consistent throughout the day
            const currentDate = new Date();
            currentDate.setUTCHours(0, 0, 0, 0);
            const millisecondsSinceEpoch = currentDate.getTime();

            // 2. .NET Epoch offset in milliseconds (January 1, 0001 to January 1, 1970)
            const dotNetMillisecondsAt_1970_01_01 = 62135596800000;
            const ticksPerMillisecond = 10000;

            // 3. Convert Javascript milliseconds to .NET ticks
            const totalMilliseconds = millisecondsSinceEpoch + dotNetMillisecondsAt_1970_01_01;
            const cachingTokenTicks = totalMilliseconds * ticksPerMillisecond;


            const a = document.createElement("a")

            const url = `${location.origin}/%7B${cachingTokenTicks}%7D/WebResources/${path ?? ""}`
            a.href = url
            a.textContent = url

            return a
        }),
});