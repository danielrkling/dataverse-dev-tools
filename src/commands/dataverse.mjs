import {
  argument,
  command,
  constant,
  integer,
  map,
  message,
  multiple,
  negatableFlag,
  object,
  option,
  optional,
  or,
  string,
  withDefault,
} from "@optique/core";
import picomatch from "picomatch";
import * as z from "zod";
import { Effect } from "effect";
import { createWatchPipeline } from "../effects/watch-pipeline.mjs";
import {
    DataverseService,
    isValidWebResource,
    isBinaryWebResource,
    buildAttributeBody,
    buildEntityBody,
    buildKeyBody,
    buildManyToManyBody,
    localizedLabel as buildAttributeLabel,
} from "../effects/dataverse-service.mjs";
import { TerminalUi } from "../effects/terminal-ui.mjs";
import { WorkspaceFs, commandLayers } from "../effects/services.mjs";
import { createCommand, attachWatchStop, friendlyError } from "../services/commands.mjs";
import { bus } from "../services/bus.mjs";

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

// ---------------------------------------------------------------------------
// `dataverse upload` — web resources (with --watch like the old top-level flow)
// ---------------------------------------------------------------------------

const uploadParser = object({
    subcommand: constant("upload"),
    prefix: optional(
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
});

/** Shared per-sub span pipeline: `dv.<sub>` span + log span.
 * @template A
 * @template [E=never]
 * @template [R=never]
 * @param {string} sub
 * @param {Effect.Effect<A, E, R>} effect
 * @returns {Effect.Effect<A, E, R>}
 */
const withDvSpan = (sub, effect) =>
    Effect.withLogSpan(Effect.withSpan(effect, `dv.${sub}`), `dv.${sub}`);

/** Map any typed failure to one friendly registry line. */
const toFriendlyError = (/** @type {any} */ err) =>
    friendlyError(err instanceof Error ? err.message : `${err?._tag ?? "Error"} ${err?.message ?? err?.path ?? err ?? ""}`.trimEnd());

/**
 * @param {any} parsed
 * @param {import("../types/terminal.d.ts").Terminal} term
 */
const uploadFlow = (parsed, term) =>
    withDvSpan("upload", Effect.gen(function* () {
        const fs = yield* WorkspaceFs;

        let { files, prefix, solution } = parsed;

        if (!(files && prefix && solution)) {
            const configFile = yield* readConfigEffect(fs, parsed.config || "dataverse.config.json");
            files ??= configFile.files ?? [];
            prefix ??= configFile.prefix;
            solution ??= configFile.solution;
        }

        const isMatch = picomatch(files ?? []);
        const entries = yield* Effect.tryPromise({
            try: () =>
                fs.getFilesFromDirectory("", isMatch, {
                    // Images/fonts must be read as bytes — a UTF-8
                    // text() decode corrupts png/jpg/ico content.
                    binary: isBinaryWebResource,
                }),
            catch: (cause) => new Error(`collecting files: ${/** @type {any} */ (cause)?.message ?? cause}`),
        });

        // Errors surface through the registry (single friendly line).
        yield* uploadFilesEffect(entries, { files, prefix, solution, publish: parsed.publish });

        if (parsed.watch) {
            const ui = yield* TerminalUi;
            const watcher = ui.startWatcher("dataverse-watch", "dv upload --watch");

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
                    // Binary web resources (png/jpg/ico…) must be read as
                    // bytes; text files as utf-8 strings.
                    const content = yield* Effect.tryPromise({
                        try: () =>
                            isBinaryWebResource(e.path)
                                ? fs.readFile(e.path)
                                : fs.readFile(e.path, { encoding: "utf8" }),                        catch: (cause) => ({
                            _tag: "ReadError",
                            message: `Could not read ${e.path}`,
                            cause,
                        }),
                    });
                    yield* uploadFilesEffect([[e.path, /** @type {string | ArrayBuffer} */ (content)]], {
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
            attachWatchStop(watcher, { pipeline, unsub });
        }

        /**
         * Upload (and optionally publish) files as an Effect using the
         * DataverseService. DOM status updates happen inline; each request
         * is retried/timed out/logged by the service.
         *
         * @param {[string,string|ArrayBuffer][]} files
         * @param {{ files: any, prefix: string, solution?: string, publish: boolean }} run
         * @returns {Effect.Effect<void, Error, any>}
         */
        function uploadFilesEffect(files, run) {
            /** @type {[string, string | ArrayBuffer][]} */
            const validFiles = /** @type {[string, string | ArrayBuffer][]} */ (
                files.map((v) => [`${run.prefix}/${v[0]}`, v[1]]).filter((v) =>
                    isValidWebResource(/** @type {string} */ (v[0])),
                )
            );
            const filenames = validFiles.map((v) => v[0]);
            if (!validFiles.length) return Effect.void;

            const describeError = (/** @type {any} */ err) =>
                `upload failed: ${err?._tag} ${err?.message ?? err?.path ?? err?.name ?? ""}`.trimEnd();

            // The upload/publish body. The failure log lives INSIDE this
            // region so it carries span context and reaches the terminal
            // logger (error paths restore FiberRefs captured at the failure
            // origin, so spans/annotations must be ambient at that point).
            const body = Effect.gen(function* () {
                // GenericTag yields an unhelpfully-narrow inferred service in
                // checkJs; cast to the impl typedef via any.
                const api = /** @type {any} */ (yield* DataverseService);
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
                    attributes: { count: validFiles.length, publish: run.publish },
                }),
                // Convert to a plain Error so the registry's error path can
                // display it — the single error report (no duplicate logging).
                Effect.mapError((err) => new Error(describeError(err))),
            );
        }

        return undefined;
    }));
// ---------------------------------------------------------------------------
// `dataverse publish` — publish already-uploaded web resources
// ---------------------------------------------------------------------------

const publishParser = object({
    subcommand: constant("publish"),
    names: map(
        multiple(
            argument(string({ metavar: "WEBRESOURCE" }), {
                description: message`Web resource names to publish (default: all in prefix)`,
            }),
        ),
        (v) => (v.length ? v : undefined),
    ),
    prefix: optional(
        option("-p", "--prefix", string({ metavar: "PREFIX" }), {
            description: message`Publish all web resources whose name starts with this prefix`,
        }),
    ),
    solution: optional(
        option("-s", "--solution", string({ metavar: "SOLUTION" }), {
            description: message`Solution name to include new web resources in`,
        }),
    ),
    config: withDefault(
        option("-c", "--config", string({ metavar: "FILE" }), {
            description: message`Path to config file (default: dataverse.config.json)`,
        }),
        "dataverse.config.json",
    ),
});

/**
 * @param {any} parsed
 * @param {import("../types/terminal.d.ts").Terminal} term
 */
const publishFlow = (parsed, term) =>
    withDvSpan("publish", Effect.gen(function* () {
        const fs = yield* WorkspaceFs;
        const api = /** @type {any} */ (yield* DataverseService);
        const ui = yield* TerminalUi;

        let { prefix, solution } = parsed;
        if (!prefix && !solution) {
            const configFile = yield* readConfigEffect(fs, parsed.config);
            prefix ??= configFile.prefix;
            solution ??= configFile.solution;
        }
        if (!prefix) {
            return "No prefix — pass -p/--prefix or set `prefix` in dataverse.config.json.";
        }

        const candidates = /** @type {string[] | undefined} */ (
            parsed.names?.length ? parsed.names.map((/** @type {string} */ n) => `${prefix}${n}`) : undefined
        );
        // Fetch server state (filtered by prefix), then intersect with an
        // explicit name list if given.
        const all = yield* api.getWebResources(prefix);
        const wrs = candidates ? all.filter((/** @type {any} */ wr) => candidates.includes(wr.name)) : all;
        if (!wrs.length) {
            term.log(candidates ? "No matching web resources found on the server." : `No web resources starting with ${prefix}.`, { class: "log-error" });
            return undefined;
        }

        const group = yield* Effect.sync(() => ui.startGroup("Publishing:", `${wrs.length} webresource(s)`));
        yield* api.publish(wrs, solution).pipe(
            Effect.tap(() => Effect.sync(() => {
                group.set("Published:", "", "#4ec9b0");
                group.detail(`${wrs.length} webresource(s)`);
            })),
            Effect.tapError(() => Effect.sync(() => {
                group.set("Failed:", "", "#f14c4c");
                group.fail();
            })),
        );
        for (const wr of wrs) {
            group.log(`✓ ${/** @type {any} */ (wr).name}`);
        }
        bus.emit("dataverse:published", { files: parsed.names ?? prefix });
        return undefined;
    }));

// ---------------------------------------------------------------------------
// `dataverse preview` — open a web resource in a new tab
// ---------------------------------------------------------------------------

const previewParser = object({
    subcommand: constant("preview"),
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
});

/**
 * @param {any} parsed
 * @param {import("../types/terminal.d.ts").Terminal} term
 */
const previewFlow = (parsed, term) =>
    withDvSpan("preview", Effect.gen(function* () {
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
    }));

// ---------------------------------------------------------------------------
// `dataverse cache` — build the cached URL of a web resource
// ---------------------------------------------------------------------------

const cacheParser = object({
    subcommand: constant("cache"),
    path: optional(
        argument(string({ metavar: "PATH" }), {
            description: message`Web resource path to create cached url for`,
        }),
    ),
});

/**
 * @param {any} parsed
 */
const cacheFlow = (parsed) =>
    withDvSpan("cache", Effect.sync(() => {
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

        const a = document.createElement("a");

        const url = `${location.origin}/%7B${cachingTokenTicks}%7D/WebResources/${path ?? ""}`;
        a.href = url;
        a.textContent = url;

        return a;
    }));

// ---------------------------------------------------------------------------
// `dataverse fetch` — generic OData query of any entity
// ---------------------------------------------------------------------------

const fetchParser = object({
    subcommand: constant("fetch"),
    entitySet: argument(string({ metavar: "ENTITYSET" }), {
        description: message`Entity set name to query (e.g. dv_things, accounts)`,
    }),
    select: map(
        multiple(
            option("--select", "-S", string({ metavar: "COL" }), {
                description: message`Columns to select (repeatable or comma-separated)`,
            }),
        ),
        (v) => v.flatMap((s) => s.split(",").map((c) => c.trim())).filter(Boolean),
    ),
    filter: optional(option("--filter", string({ metavar: "ODATA" }), {
        description: message`OData $filter expression (quote it)`,
    })),
    top: optional(option("--top", "-t", integer({ metavar: "N" }), {
        description: message`Max number of records`,
    })),
    order: optional(option("--order-by", string({ metavar: "COL" }), {
        description: message`Order expression, e.g. createdon desc`,
    })),
    expand: optional(option("--expand", string({ metavar: "NAV" }), {
        description: message`$expand navigation property`,
    })),
});

/**
 * @param {any} parsed
 * @param {import("../types/terminal.d.ts").Terminal} term
 */
const fetchFlow = (parsed, term) =>
    withDvSpan("fetch", Effect.gen(function* () {
        const api = /** @type {any} */ (yield* DataverseService);
        const rows = yield* api.query(parsed.entitySet, {
            select: parsed.select?.length ? parsed.select : undefined,
            filter: parsed.filter,
            top: parsed.top,
            orderBy: parsed.order,
            expand: parsed.expand,
        });
        if (!rows.length) return `0 record(s) for ${parsed.entitySet}`;
        for (const row of rows) term.info(JSON.stringify(row));
        return `${rows.length} record(s) for ${parsed.entitySet}`;
    }));

// ---------------------------------------------------------------------------
// `dataverse schema` — create/update tables, columns, keys, N:N from JSON
// ---------------------------------------------------------------------------

const schemaConfigSchema = z.object({
    solution: z.string().optional(),
    tables: z.array(
        z.object({
            schemaName: z.string(),
            displayName: z.string(),
            pluralDisplay: z.string().optional(),
            collectionName: z.string().optional(),
            entitySetName: z.string().optional(),
            ownership: z.string().optional(),
            description: z.string().optional(),
            columns: z
                .array(
                    z.object({
                        logicalName: z.string(),
                        displayName: z.string(),
                        description: z.string().optional(),
                        type: z.enum([
                            "string", "memo", "integer", "decimal", "double",
                            "money", "boolean", "lookup", "choice", "datetime",
                        ]),
                        required: z.boolean().optional(),
                        maxLength: z.number().optional(),
                        relationship: z.object({
                            schemaName: z.string(),
                            to: z.string(),
                        }).optional(),
                        options: z
                            .array(
                                z.object({
                                    value: z.union([z.number(), z.string()]),
                                    label: z.string(),
                                }),
                            )
                            .optional(),
                        odata: z.record(z.string(), z.any()).optional(),
                    }),
                )
                .optional(),
            keys: z
                .array(
                    z.object({
                        schemaName: z.string(),
                        attributes: z.array(z.string()),
                        odata: z.record(z.string(), z.any()).optional(),
                    }),
                )
                .optional(),
            relationships: z
                .array(
                    z.object({
                        type: z.literal("N:N"),
                        schemaName: z.string(),
                        with: z.string(),
                        intersect: z.string().optional(),
                        display: z.string().optional(),
                        odata: z.record(z.string(), z.any()).optional(),
                    }),
                )
                .optional(),
            odata: z.record(z.string(), z.any()).optional(),
        }),
    ),
});

const schemaExportParser = object({
    subcommand: constant("schema"),
    schemaAction: constant("export"),
    logicalName: argument(string({ metavar: "TABLE" }), {
        description: message`Logical table name to export (e.g. dv_thing)`,
    }),
    out: optional(
        argument(string({ metavar: "FILE" }), {
            description: message`Output schema file (default: dataverse.<table>.schema.json)`,
        }),
    ),
});

const schemaApplyParser = object({
    subcommand: constant("schema"),
    schemaAction: withDefault(constant("apply"), "apply"),
    file: withDefault(
        argument(string({ metavar: "FILE" }), {
            description: message`Schema JSON file (default: dataverse.schema.json)`,
        }),
        "dataverse.schema.json",
    ),
    init: optional(
        option("--init", {
            description: message`Scaffold an example schema file and exit`,
        }),
    ),
    dryRun: optional(
        option("--dry-run", {
            description: message`Validate and print the plan without calling the API`,
        }),
    ),
});

const schemaParser = or(
    or(command("export", schemaExportParser), command("pull", schemaExportParser)),
    or(
        command("import", schemaApplyParser),
        command("apply", schemaApplyParser),
        schemaApplyParser, // bare `dv schema [file]` applies by default
    ),
);

const dvSchemaScaffold = {
    solution: "",
    tables: [
        {
            schemaName: "dv_thing",
            displayName: "Thing",
            description: "Example table scaffolded by `dv schema --init`",
            columns: [
                { logicalName: "dv_title", displayName: "Title", type: "string", maxLength: 100, required: true },
                { logicalName: "dv_color", displayName: "Color", type: "choice", options: [{ value: 100000000, label: "Red" }] },
                { logicalName: "dv_amount", displayName: "Amount", type: "money" },
                { logicalName: "dv_active", displayName: "Active", type: "boolean" },
                { logicalName: "dv_due", displayName: "Due", type: "datetime" },
                {
                    logicalName: "dv_account",
                    displayName: "Account",
                    type: "lookup",
                    relationship: { schemaName: "dv_thing_account", to: "account" },
                },
            ],
            keys: [{ schemaName: "dv_thing_key", attributes: ["dv_title"] }],
            relationships: [{ type: "N:N", schemaName: "dv_things_accounts", with: "account" }],
        },
    ],
};

/**
 * Apply one logical create-or-update decision, reported as strings.
 * @param {Array<string>} lines
 * @param {"created"|"updated"|"exists"} verb
 * @param {string} what
 */
function reportSchemaOp(lines, verb, what) {
    lines.push(verb === "created" ? `✓ created ${what}` : verb === "updated" ? `~ updated ${what}` : `= ${what} up to date`);
}

/**
 * Apply the schema plan (create/update tables, columns, keys, N:N).
 * @param {any} parsed
 * @param {import("../types/terminal.d.ts").Terminal} term
 */
const schemaApplyFlow = (parsed, term) =>
    withDvSpan("schema", Effect.gen(function* () {
        const fs = yield* WorkspaceFs;
        const ui = yield* TerminalUi;

        // --- scaffold ---
        if (parsed.init) {
            if (yield* Effect.tryPromise({ try: () => fs.exists(parsed.file), catch: () => new Error("Could not check if the target exists") })) {
                term.error(`${parsed.file} already exists — remove it first if you want to re-scaffold.`);
                return undefined;
            }
            yield* Effect.tryPromise({
                try: () => fs.writeFile(parsed.file, `${JSON.stringify(dvSchemaScaffold, null, 2)}\n`, "utf8"),
                catch: (cause) => new Error(`write ${parsed.file}: ${/** @type {any} */ (cause)?.message ?? cause}`),
            });
            term.success(`Wrote ${parsed.file} — edit it, then run: dv schema ${parsed.file}`);
            return undefined;
        }

        // --- read + validate the plan ---
        const raw = yield* Effect.tryPromise({
            try: async () => JSON.parse(/** @type {string} */ (await fs.readFile(parsed.file, { encoding: "utf-8" }))),
            catch: (/** @type {any} */ e) => new Error(`Error reading ${parsed.file}: ${e?.message ?? e}`),
        });
        const parsedPlan = schemaConfigSchema.safeParse(raw);
        if (!parsedPlan.success) {
            return `Error parsing ${parsed.file}:\n${z.prettifyError(parsedPlan.error)}`;
        }
        const plan = /** @type {import("zod").infer<typeof schemaConfigSchema>} */ (parsedPlan.data);

        if (parsed.dryRun) {
            for (const t of plan.tables) {
                term.info(`table ${t.schemaName} (${t.columns?.length ?? 0} columns, ${t.keys?.length ?? 0} keys, ${t.relationships?.length ?? 0} N:N)`);
            }
            return `Plan ok — ${plan.tables.length} table(s). Re-run without --dry-run to apply.`;
        }

        // --- apply ---
        const api = /** @type {any} */ (yield* DataverseService);
        const solution = plan.solution || undefined;
        const group = yield* Effect.sync(() =>
            ui.startGroup("Applying schema:", plan.tables.map((t) => t.schemaName).join(",")),
        );

        /** @type {string[]} */
        const lines = [];
        let changed = 0;
        /**
         * Apply one logical create-or-update decision, reported into the card.
         * @param {string} what
         * @param {Effect.Effect<any, any>} op
         */
        const attempt = (what, op) =>
            op.pipe(
                Effect.tap(() => Effect.sync(() => { group.log(`✓ ${what}`); lines.push(`✓ ${what}`); changed++; })),
                Effect.catchAll((/** @type {any} */ err) =>
                    Effect.sync(() => {
                        const msg = `${err?.status ? `HTTP ${err.status}` : err?._tag ?? "Error"}: ${err?.message ?? err ?? ""}`;
                        group.log(`× ${what} — ${msg}`);
                        lines.push(`× ${what} — ${msg}`);
                    }),
                ),
            );

        /** Shorthand: first localized label text of a localized-metadata object.
         * @param {any} meta
         * @returns {string | undefined}
         */
        const labelText = (meta) => meta?.LocalizedLabels?.find((/** @type {any} */ l) => l.Label)?.Label;

        /**
         * Whether an existing column differs from the desired schema entry.
         * Diffs only what the plan itself expresses (labels, required,
         * maxLength, choice options); any `odata` passthrough forces an
         * update since its server counterpart can't be anticipated.
         * @param {any} existing full AttributeMetadata from the org
         * @param {any} col desired column entry from the plan
         * @returns {boolean}
         */
        /**
         * Diff the desired column plan against the live metadata. Returns a
         * list of mismatch reasons (empty = up to date). Any `odata`
         * passthrough always counts as a diff since the server counterpart
         * can't be anticipated.
         *
         * @param {any} existing full AttributeMetadata from the org
         * @param {any} col desired column entry from the plan
         * @returns {string[]}
         */
        const attributeDiffs = (existing, col) => {
            /** @type {string[]} */
            const reasons = [];
            if (col.odata && Object.keys(col.odata).length) return ["odata passthrough"];
            if (labelText(existing.DisplayName) !== col.displayName) return ["displayName"];
            const wantDesc = col.description ?? undefined;
            if ((labelText(existing.Description) ?? undefined) !== (wantDesc ?? undefined)) return ["description"];
            const wantReq = col.required ? "ApplicationRequired" : "None";
            if ((existing.RequiredLevel?.Value ?? "None") !== wantReq) return ["required"];
            if (col.maxLength != null && existing.MaxLength != null && existing.MaxLength !== col.maxLength) {
                return ["maxLength"];
            }
            if (col.type === "choice") {
                const want = (col.options ?? []).map((/** @type {any} */ o) => `${o.value}:${o.label}`).sort().join("|");
                const have = (existing.OptionSet?.Options ?? [])
                    .map((/** @type {any} */ o) => `${o.Value}:${labelText(o.Label)}`).sort().join("|");
                if (want && want !== have) return ["options"];
            }
            return reasons;
        };

        // Lookup columns' choices need firstLabelSafe too (defined after export
        // helpers, so a tiny local mirror is used here).
        /**
         * @param {any} meta
         * @returns {string | undefined}
         */
        function firstLabelSafe(meta) {
            return meta?.LocalizedLabels?.find((/** @type {any} */ l) => l.Label)?.Label;
        }

        /**
         * Ensure one table + its columns + its keys (each column/key level
         * parallelized with bounded concurrency).
         * @param {import("zod").infer<typeof schemaConfigSchema>["tables"][number]} t
         */
        const applyTable = (t) =>
            Effect.gen(function* () {
                const logical = t.schemaName.toLowerCase();
                const existing = yield* /** @type {any} */ (api.getEntityMetadata(logical));
                if (!existing) {
                    yield* attempt(`table ${t.schemaName}`, api.createEntity(buildEntityBody(t), solution));
                } else {
                    // Labels diff: only PUT when something in the plan diverges.
                    const nameDiff = t.displayName && labelText(existing.DisplayName) !== t.displayName;
                    const descDiff = t.description != null &&
                        (labelText(existing.Description) ?? undefined) !== (t.description ?? undefined);
                    if (nameDiff || descDiff) {
                        const patch = /** @type {Record<string, unknown>} */ ({});
                        if (nameDiff && t.displayName) patch.DisplayName = buildAttributeLabel(t.displayName);
                        if (descDiff && t.description) patch.Description = buildAttributeLabel(t.description);
                        yield* attempt(`table ${t.schemaName}`, api.updateEntity(logical, patch, solution));
                    }
                }

                yield* Effect.forEach(
                    t.columns ?? [],
                    /** @param {any} col */
                    (col) =>
                        Effect.gen(function* () {
                            const existingCol = yield* /** @type {any} */ (
                                api.getColumnMetadata(logical, col.logicalName)
                            );
                            const body = buildAttributeBody(col);
                            if (!existingCol) {
                                yield* attempt(`column ${t.schemaName}.${col.logicalName}`, api.createAttribute(logical, body, solution));
                            } else {
                                const reasons = attributeDiffs(existingCol, col);
                                if (reasons.length) {
                                    yield* attempt(
                                        `column ${t.schemaName}.${col.logicalName} (${reasons.join(", ")})`,
                                        api.updateAttribute(logical, col.logicalName, body, solution),
                                    );
                                } else {
                                    group.log(`= ${t.schemaName}.${col.logicalName} up to date`);
                                    lines.push(`= column ${t.schemaName}.${col.logicalName}`);
                                }
                            }
                        }),
                    { concurrency: 3 },
                );

                yield* Effect.forEach(
                    t.keys ?? [],
                    /** @param {any} key */
                    (key) => attempt(`key ${key.schemaName}`, api.createAlternateKey(logical, buildKeyBody(key), solution)),
                    { concurrency: 3 },
                );
            });

        // Tables (and their columns/keys) run one at a time — metadata writes
        // to the same org are throttled hard by Dataverse; parallelism lives
        // at the per-column level, plus server-side Retry-After handling.
        yield* Effect.forEach(plan.tables, applyTable, { concurrency: 1 });

        // N:N relationships may reference any table → after all tables exist.
        /** @type {{ t: any, rel: any }[]} */
        const allRels = plan.tables.flatMap((t) => (t.relationships ?? []).map((rel) => ({ t, rel })));
        yield* Effect.forEach(
            allRels,
            /** @param {{ t: any, rel: any }} e */
            (e) =>
                Effect.gen(function* () {
                    const exists = yield* /** @type {any} */ (api.getRelationship(e.rel.schemaName));
                    if (exists) {
                        group.log(`= relationship ${e.rel.schemaName} up to date`);
                        lines.push(`= relationship ${e.rel.schemaName}`);
                        return;
                    }
                    yield* attempt(
                        `relationship ${e.rel.schemaName}`,
                        api.createManyToMany(buildManyToManyBody({ ...e.rel, from: e.t.schemaName }), solution),
                    );
                }),
            { concurrency: 3 },
        );

        group.set(changed ? "Applied:" : "No changes:", "", changed ? "#4ec9b0" : "#8b949e");
        group.detail(`${lines.length} action(s)`);
        // Failures are already in the collapsible body; the event log gets the counts.
        const failed = lines.filter((l) => l.startsWith("×")).length;
        if (failed) {
            group.fail(); // auto-open the collapsed body so the × lines are visible
            term.error(`${failed} schema action(s) failed — expand the schema line for details.`);
        }
        return undefined;
    }));

// ---------------------------------------------------------------------------
// `dataverse schema export` — pull a live table into a schema JSON file
// ---------------------------------------------------------------------------

/** OData AttributeType → dv schema `type`. */
const ATTRIBUTE_TYPE_MAP = /** @type {Record<string, string>} */ ({
    String: "string",
    Memo: "memo",
    Integer: "integer",
    Decimal: "decimal",
    Double: "double",
    Money: "money",
    Boolean: "boolean",
    Lookup: "lookup",
    Picklist: "choice",
    DateTime: "datetime",
});

/**
 * Detect system-generated companion attributes — the server creates these
 * automatically when the parent structure is created, so they must never be
 * re-created from an exported schema.
 *
 * Dataverse marks them structurally, not by name:
 * - `AttributeOf` — mirror attribute whose value shadows another (the
 *   `<lookup>name` text companion of a lookup, `revenue_base` money pair, …)
 * - `IsLogical` — logical attributes (values derived from linked metadata)
 * - `IsComposite` — compound attributes (superclass address fields, etc.)
 * - `AttributeType: "Virtual"` — computed/virtual columns (owner, activity…)
 *
 * @param {any} attr raw AttributeMetadata (full fetch — needs these props)
 * @returns {boolean}
 */
function isSystemGeneratedAttribute(attr) {
    return Boolean(
        attr.AttributeOf ||
        attr.IsLogical === true ||
        attr.IsComposite === true ||
        attr.AttributeType === "Virtual" ||
        // Lookup companions also arrive as e.g. "LookupSimple"/"EntityName"
        // with IsCustomAttribute === false on some serialization paths —
        // treat any non-custom attribute we didn't create as system-managed.
        attr.AttributeType === "LookupSimple",
    );
}
const SYSTEM_ATTRIBUTES = new Set([
    "statecode", "statuscode", "createdon", "createdby", "modifiedon", "modifiedby",
    "ownerid", "owningbusinessunit", "owningteam", "owninguser", "versionnumber",
    "importsequencenumber", "overriddencreatedon", "timezoneruleversionnumber",
    "utcconversiontimezonecode", "createdbyname", "modifiedbyname",
]);

/** First localized label of a localized-metadata object.
 * @param {any} meta
 * @returns {string | undefined}
 */
const firstLabel = (meta) => meta?.LocalizedLabels?.find((/** @type {any} */ l) => l.Label)?.Label;

/**
 * @param {any} parsed
 * @param {import("../types/terminal.d.ts").Terminal} term
 */
const schemaExportFlow = (parsed, term) =>
    withDvSpan("schema-export", Effect.gen(function* () {
        const fs = yield* WorkspaceFs;
        const api = /** @type {any} */ (yield* DataverseService);
        const logical = parsed.logicalName.toLowerCase();
        const out = parsed.out ?? `dataverse.${logical}.schema.json`;

        if (yield* Effect.tryPromise({ try: () => fs.exists(out), catch: () => new Error("Could not check if the target exists") })) {
            term.error(`${out} already exists — pass another FILE or remove it first.`);
            return undefined;
        }

        const def = yield* api.getEntityDefinition(
            logical,
            "Attributes,OneToManyRelationships,ManyToManyRelationships,Keys",
        );
        if (!def) return `Table '${logical}' not found.`;
        void def;

        /**
         * @param {any} attr
         */
        const toColumn = (attr) => {
            const type = ATTRIBUTE_TYPE_MAP[attr.AttributeType ?? ""] ?? "string";
            /** @type {Record<string, unknown>} */
            const col = {
                logicalName: attr.LogicalName,
                displayName: firstLabel(attr.DisplayName) ?? attr.SchemaName,
                type,
                required: ["ApplicationRequired", "SystemRequired"].includes(
                    attr.RequiredLevel?.Value ?? "None",
                ),
            };
            if (attr.Description) col.description = firstLabel(attr.Description);
            if (attr.MaxLength != null && type === "string") col.maxLength = attr.MaxLength;
            if (type === "choice") {
                col.options = (attr.OptionSet?.Options ?? []).map((/** @type {any} */ o) => ({
                    value: o.Value,
                    label: firstLabel(o.Label) ?? String(o.Value),
                }));
            }
            if (type === "lookup") {
                const o2m = (def.OneToManyRelationships ?? []).find((/** @type {any} */ r) =>
                    (attr.Targets ?? []).includes(r.ReferencedEntity),
                );
                col.relationship = o2m
                    ? { schemaName: o2m.SchemaName, to: o2m.ReferencedEntity }
                    : { schemaName: `${logical}_${attr.LogicalName}`, to: (attr.Targets ?? [])[0] ?? "" };
            }
            return col;
        };

        /** @type {any} */
        /**
         * @param {any} rel
         */
        const toRelationship = (rel) => ({
            type: "N:N",
            schemaName: rel.SchemaName,
            with: rel.Entity1LogicalName === logical ? rel.Entity2LogicalName : rel.Entity1LogicalName,
            intersect: rel.IntersectEntityName && rel.IntersectEntityName !== rel.SchemaName
                ? rel.IntersectEntityName
                : undefined,
        });

        /** @type {any} */
        const schemaDoc = {
            solution: "",
            tables: [
                {
                    schemaName: def.SchemaName,
                    displayName: firstLabel(def.DisplayName) ?? def.SchemaName,
                    description: firstLabel(def.Description),
                    collectionName: def.LogicalCollectionName,
                    entitySetName: def.EntitySetName,
                    ownership: def.OwnershipType,
                    columns: (def.Attributes ?? [])
                        .filter((/** @type {any} */ a) => !SYSTEM_ATTRIBUTES.has(a.LogicalName))
                        .filter((/** @type {any} */ a) => !isSystemGeneratedAttribute(a))
                        .map(toColumn),
                    keys: (def.Keys ?? def.AlternateKeys ?? []).map((/** @type {any} */ k) => ({
                        schemaName: k.SchemaName ?? k.Name,
                        // REST EntityKeyMetadata exposes the member columns either
                        // as plain logical-name strings (KeyAttributes) or as
                        // attribute references (EntityKeyAttributes objects).
                        attributes: (k.EntityKeyAttributes ?? k.KeyAttributes ?? []).map((/** @type {any} */ a) =>
                            typeof a === "string" ? a : a.LogicalName ?? a.Name,
                        ),
                    })),
                    relationships: (def.ManyToManyRelationships ?? []).map(toRelationship),
                },
            ],
        };

        yield* Effect.tryPromise({
            try: () => fs.writeFile(out, `${JSON.stringify(schemaDoc, null, 2)}\n`, "utf8"),
            catch: (cause) => new Error(`write ${out}: ${/** @type {any} */ (cause)?.message ?? cause}`),
        });
        term.success(
            `Exported ${schemaDoc.tables[0].columns.length} column(s), ${schemaDoc.tables[0].keys.length} key(s), ${schemaDoc.tables[0].relationships.length} N:N from ${def.SchemaName} → ${out}`,
        );
        return undefined;
    }));

// ---------------------------------------------------------------------------
// `dataverse init` — scaffold the project config (and optional schema file)
// ---------------------------------------------------------------------------

const initParser = object({
    subcommand: constant("init"),
    config: withDefault(
        option("-c", "--config", string({ metavar: "FILE" }), {
            description: message`Path to config file (default: dataverse.config.json)`,
        }),
        "dataverse.config.json",
    ),
    schema: optional(
        option("--schema", {
            description: message`Also scaffold dataverse.schema.json`,
        }),
    ),
});

/**
 * @param {any} parsed
 * @param {import("../types/terminal.d.ts").Terminal} term
 */
const initFlow = (parsed, term) =>
    withDvSpan("init", Effect.gen(function* () {
        const fs = yield* WorkspaceFs;

        if (yield* Effect.tryPromise({ try: () => fs.exists(parsed.config), catch: () => new Error("Could not check if the target exists") })) {
            term.error(`${parsed.config} already exists — remove it first if you want to re-scaffold.`);
        } else {
            const scaffold = {
                prefix: "new_",
                files: ["**/*.js", "**/*.mjs", "**/*.html", "**/*.css"],
                solution: "",
                preview: "",
            };
            yield* Effect.tryPromise({
                try: () => fs.writeFile(parsed.config, `${JSON.stringify(scaffold, null, 2)}\n`, "utf8"),
                catch: (cause) => new Error(`write ${parsed.config}: ${/** @type {any} */ (cause)?.message ?? cause}`),
            });
            term.success(
                `Wrote ${parsed.config} — set prefix (must contain an underscore) and optionally solution.`,
            );
        }

        if (parsed.schema) {
            if (yield* Effect.tryPromise({ try: () => fs.exists("dataverse.schema.json"), catch: () => new Error("Could not check if the target exists") })) {
                term.error("dataverse.schema.json already exists — remove it first if you want to re-scaffold.");
            } else {
                yield* Effect.tryPromise({
                    try: () => fs.writeFile("dataverse.schema.json", `${JSON.stringify(dvSchemaScaffold, null, 2)}\n`, "utf8"),
                    catch: (cause) => new Error(`write dataverse.schema.json: ${/** @type {any} */ (cause)?.message ?? cause}`),
                });
                term.success("Wrote dataverse.schema.json — edit it, then run: dv schema");
            }
        }
        return undefined;
    }));

// ---------------------------------------------------------------------------
// Command assembly: `dataverse` (dv) with nested subcommands
// ---------------------------------------------------------------------------

const dvParser = or(
    or(
        command("init", initParser),
        command("upload", uploadParser),
        command("up", uploadParser),
        command("publish", publishParser),
    ),
    or(
        command("preview", previewParser),
        command("pv", previewParser),
        command("cache", cacheParser),
        command("fetch", fetchParser),
        command("schema", schemaParser),
    ),
);

const dvFlows = /** @type {const} */ ({
    init: initFlow,
    upload: uploadFlow,
    publish: publishFlow,
    preview: previewFlow,
    cache: cacheFlow,
    fetch: fetchFlow,
    schema: /** Routes `dv schema`/`dv schema export` within one subcommand.
     * @param {any} parsed @param {any} term */
    (parsed, term) => (parsed.schemaAction === "export" ? schemaExportFlow(parsed, term) : schemaApplyFlow(parsed, term)),
});

export const dataverseCommand = createCommand({
    name: "dataverse",
    aliases: ["dv"],
    parser: dvParser,
    description: message`Manage Dataverse web resources, data and metadata`,
    usage: message`dataverse init | dataverse upload [files..] [options] | dataverse publish [--prefix P] | dataverse preview [path] | dataverse cache [path] | dataverse fetch <entityset> [options] | dataverse schema import <file> [--dry-run] | dataverse schema export <table>`,
    brief: message`Manage Dataverse web resources, data and metadata`,
    timeoutSeconds: 600, // uploads/imports are batched with retries — don't cut at 60s
    /**
     * Effect-based execution: dispatches to the per-subcommand flow, each
     * with its own `dv.<sub>` span + log span and a single friendly Error.
     *
     * @param {any} parsed
     * @param {import("../types/terminal.d.ts").Terminal} term
     * @returns {Effect.Effect<string | undefined, Error>}
     */
    executeEffect: (parsed, term) => {
        const subcommand = /** @type {keyof typeof dvFlows} */ (parsed.subcommand);
        const flow = dvFlows[subcommand];
        if (!flow) return Effect.succeed(undefined);
        return /** @type {Effect.Effect<string | undefined, Error>} */ (
            /** @type {any} */ (flow(parsed, term)).pipe(Effect.mapError(toFriendlyError))
        );
    },
});
