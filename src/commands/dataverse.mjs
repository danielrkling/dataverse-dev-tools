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
import { createCommand } from "../services/commands.mjs";
import { debounce } from "../utils/debounce.mjs";
import { isValidWebResource, publishWebResources, uploadWebResource } from "../services/dataverse.mjs";
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
});

export const uploadCommand = createCommand({
    name: "upload",
    parser: uploadParser,
    aliases: ["ul"],
    description: message`Upload web resources to Dataverse`,
    usage: message`upload [files..] [options]`,
    brief: message`Upload web resources to Dataverse`,
    execute: async (parsed, term) => {
        let { files, prefix, solution } = parsed;

        if (!(files && prefix && solution)) {
            const configFile = await readConfig(term, parsed.config);
            files ??= configFile.files ?? [];
            prefix ??= configFile.prefix;
            solution ??= configFile.solution;
        }

        const isMatch = picomatch(files ?? []);
        const entries = await term.fs.getFilesFromDirectory("", isMatch);

        uploadFiles(entries);

        if (parsed.watch) {
            /** @type {(e: CustomEvent) => Promise<void>} */
            const handler = async (e) => {
                const changedPath = /** @type {any} */ (e).detail?.path;
                if (!changedPath || !isMatch(changedPath)) return;
                const content = await term.fs.readFile(changedPath, { encoding: "utf8" });
                debounce(300,`upload${changedPath}`,()=>uploadFiles([[changedPath, content]]));
            };
            const unsub = bus.on("fs:changed", handler)
            const stopBtn = document.createElement("button");
            stopBtn.textContent = "⏹ stop watching";
            stopBtn.addEventListener("click", () => {
                unsub()
                stopBtn.remove();
            });
            term.log(stopBtn);
        } 

        /**
         *
         * @param {[string,string][]} files
         */
        async function uploadFiles(files) {
            
            const validFiles = files.map((v) => [`${prefix}/${v[0]}`, v[1]]).filter((v) => isValidWebResource(v[0]));
            const filenames = validFiles.map(v=>v[0])
            if (!validFiles.length) return;

            const line = document.createElement("div");
            const status = document.createElement("span");
            status.innerText = "Uploading:".padEnd(12);
            const fileList = document.createElement("span");
            fileList.innerText = validFiles.length > 3 ? `${"\n".padEnd(8)}${filenames.join("\n".padEnd(8))}`:` ${filenames.join(",")}`;
            fileList.style.color = "#ccc";
            line.append(status, fileList);
            term.log(line);

            const wrs = await Promise.all(
                validFiles.map(([name, content]) => uploadWebResource(name, content, solution)),
            );
            status.style.color = "#4fc1ff";
            status.innerText = "Uploaded:".padEnd(12);
            bus.emit("dataverse:uploaded", { files })
            if (parsed.publish) {
                status.innerText = "Publishing";
                await publishWebResources(wrs);
                status.style.color = "#4ec9b0";
                status.innerText = "Published:".padEnd(12);
                bus.emit("dataverse:published", { files })

            }
        }
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