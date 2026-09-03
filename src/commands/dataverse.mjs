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
import { Effect, Layer } from "effect";
import { createWatchPipeline } from "../effects/watch-pipeline.mjs";
import { DataverseService, DataverseServiceLive } from "../effects/dataverse-service.mjs";
import { terminalLoggerLayer } from "../effects/logger.mjs";
import { TerminalUi, terminalUiLayer } from "../effects/terminal-ui.mjs";
import { createCommand } from "../services/commands.mjs";
import { isValidWebResource } from "../effects/dataverse-service.mjs";
import {bus} from "../services/bus.mjs"

export const dataverseConfigSchema = z.object({
    prefix: z.string(),
    solution: z.string().optional(),
    files: z.array(z.string()).optional(),
    preview: z.string().optional(),
    refresh: z.string().optional(),
});

/**
 * Read and validate a dataverse config file.
 * @param {any} term
 * @param {string} path
 * @returns {Promise<import("zod").infer<typeof dataverseConfigSchema>>}
 */
async function readConfig(term, path) {
    let raw;
    try {
        raw = JSON.parse(await term.fs.readFile(path, { encoding: "utf-8" }));
    } catch (/** @type {any} */ e) {
        throw new Error(`Error reading ${path}:\n${e instanceof Error ? e.message : e}`);
    }
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
    execute: async (parsed, term) => {
        // --- `upload --init`: scaffold the default config file ---
        if (parsed.init) {
            const configPath = parsed.config || "dataverse.config.json";
            if (await term.fs.exists(configPath)) {
                term.error(`${configPath} already exists — remove it first if you want to re-scaffold.`);
                return;
            }
            const scaffold = {
                prefix: "new_",
                files: ["**/*.js", "**/*.mjs", "**/*.html", "**/*.css"],
                solution:"",
                preview:""
            };
            await term.fs.writeFile(configPath, `${JSON.stringify(scaffold, null, 2)}\n`, "utf8");
            term.success(
                `Wrote ${configPath} — set prefix (must contain an underscore) and optionally solution.`,
            );
            return;
        }

        let { files, prefix, solution } = parsed;

        if (!(files && prefix && solution)) {
            const configFile = await readConfig(term, parsed.config);
            files ??= configFile.files ?? [];
            prefix ??= configFile.prefix;
            solution ??= configFile.solution;
        }

        const isMatch = picomatch(files ?? []);
        const entries = await term.fs.getFilesFromDirectory("", isMatch);

        // Fire-and-forget: the promise is not awaited by the registry, so
        // this catch is the single error reporter for the initial upload.
        Effect.runPromise(
            /** @type {Effect.Effect<void, any, never>} */ (uploadFilesEffect(entries)),
        ).catch((e) => {
            term.error(/** @type {any} */ (e)?.message ?? String(e));
        });

        if (parsed.watch) {
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
                    const content = yield* Effect.tryPromise({
                        try: () => term.fs.readFile(e.path, { encoding: "utf8" }),
                        catch: (cause) => ({
                            _tag: "ReadError",
                            message: `Could not read ${e.path}`,
                            cause,
                        }),
                    });
                    yield* uploadFilesEffect([[e.path, /** @type {string} */ (content)]]);
                    yield* Effect.logInfo(`watch upload complete for ${e.path}`).pipe(
                        Effect.annotateLogs({ type: e.type }),
                    );
                }).pipe(
                    Effect.withSpan("dataverse.watch-upload", { attributes: { path: e.path } }),
                );

            const pipeline = createWatchPipeline({
                name: "dataverse-upload",
                debounceMs: 300,
                match: isMatch,
                handler: uploadEffect,
                term,
                layer: DataverseServiceLive,
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
        }

        /**
         * Upload (and optionally publish) files as an Effect using the
         * DataverseService. DOM status updates happen inline; each request
         * is retried/timed out/logged by the service.
         *
         * @param {[string,string][]} files
         * @returns {Effect.Effect<void, any, any>}
         */
        function uploadFilesEffect(files) {
            const runId = Math.random().toString(36).slice(2, 7);
            const validFiles = files.map((v) => [`${prefix}/${v[0]}`, v[1]]).filter((v) => isValidWebResource(v[0]));
            const filenames = validFiles.map((v) => v[0]);
            if (!validFiles.length) return Effect.void;

            const describeError = (/** @type {any} */ err) =>
                `upload failed: ${err?._tag} ${err?.message ?? err?.path ?? err?.name ?? ""}`.trimEnd();

            // The upload/publish body. The failure log lives INSIDE this
            // region so it carries span context and reaches the terminal
            // logger (error paths restore FiberRefs captured at the failure
            // origin, so spans/annotations must be ambient at that point).
            const body = Effect.gen(function* () {
                const api = yield* Effect.provide(DataverseService, DataverseServiceLive);
                const ui = yield* Effect.provide(TerminalUi, terminalUiLayer(term));
                const line = yield* Effect.sync(() => ui.startLine("Uploading:", filenames.join(",")));

                // Concurrency 3: parallel but bounded — no request stampede.
                const wrs = yield* Effect.forEach(
                    validFiles,
                    ([name, content]) => api.upload(name, content, solution),
                    { concurrency: 3 },
                ).pipe(
                    // Errors here are service failures — recolor the line.
                    Effect.tapError(() => Effect.sync(() => line.set("Failed:", "", "#f14c4c"))),
                );
                line.set("Uploaded:", "", "#4fc1ff");
                bus.emit("dataverse:uploaded", { files });
                if (parsed.publish) {
                    line.set("Publishing", "", "#e2c08d");
                    yield* api.publish(wrs, solution).pipe(
                        Effect.tapError(() => Effect.sync(() => line.set("Failed:", "", "#f14c4c"))),
                    );
                    line.set("Published:", "", "#4ec9b0");
                    bus.emit("dataverse:published", { files });
                }
                yield* Effect.logInfo(`upload batch complete`).pipe(
                    Effect.annotateLogs({ runId, count: validFiles.length, publish: Boolean(parsed.publish) }),
                );
            });

            return body.pipe(
                Effect.withSpan("dataverse.uploadFiles", {
                    attributes: { runId, count: validFiles.length, publish: Boolean(parsed.publish) },
                }),
                Effect.withLogSpan("dataverse.uploadFiles"),
                // Convert to a plain Error so the registry's error path can
                // display it — the single error report (no duplicate logging).
                Effect.mapError((err) => new Error(describeError(err))),
                // This command runs via plain `execute`, whose inner
                // Effect.runPromise creates a fresh runtime — the terminal
                // logger must be provided here explicitly.
                Effect.provide(terminalLoggerLayer(term)),
            );
        }

        // Note: the initial upload is kicked off right after the file list
        // is gathered (see above). Errors surface through the registry.
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
    execute: async (parsed, term) => {
        let { preview } = parsed;

        if (!preview) {
            preview = (await readConfig(term, parsed.config)).preview;
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
    },
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
    execute: async (parsed, term) => {
        let { path } = parsed;

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
    },
});