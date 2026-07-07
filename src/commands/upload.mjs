import { uploadWebResource, publishWebResources, isValidWebResource } from "../wr.mjs";
import { createCommand, WebTerminal } from "../terminal.mjs";
import { dataverseConfigSchema } from "../utils/schemas.mjs";
import { object, argument, string, message, option, optional, multiple } from "@optique/core";
import picomatch from "picomatch";

const uploadParser = object({
    paths: multiple(argument(string({ metavar: "FILES" }), {
        description: message`Files or glob patterns to upload`,
    })),
    config: optional(option("-c", "--config", string({ metavar: "FILE" }), {
        description: message`Path to config file (default: dataverse.config.json)`,
    })),
    prefix: optional(option("-p", "--prefix", string({ metavar: "PREFIX" }))),
    solution: optional(option("-s", "--solution", string({ metavar: "SOLUTION" }))),
    watch: optional(option("--watch", {
        description: message`Watch for changes and auto-upload`,
    })),
});

export const uploadCommand = createCommand({
    name: "upload",
    parser: uploadParser,
    aliases: ["ul"],
    description: message`Upload web resources to Dataverse`,
    usage: message`upload [files..] [options]`,
    brief: message`Upload web resources to Dataverse`,
    execute: async (parsed, term) => {
        const configPath = parsed.config || "dataverse.config.json";

        let rawConfig;
        try {
            const content = await term.fs.readFile(configPath, { encoding: "utf8" });
            rawConfig = JSON.parse(content);
        } catch (e) {
            if (parsed.config) {
                term.error(`${configPath}: ${e.message}`);
                return;
            }
            rawConfig = {};
        }

        const configResult = dataverseConfigSchema.safeParse(rawConfig);
        if (!configResult.success) {
            term.error(`${configPath}: ${configResult.error.issues.map(i => i.message).join(", ")}`);
            return;
        }
        const validatedConfig = configResult.data;

        const { config: _, ...cliFields } = parsed;
        const mergedResult = dataverseConfigSchema.safeParse({ ...validatedConfig, ...cliFields });
        if (!mergedResult.success) {
            term.error(`Config merge: ${mergedResult.error.issues.map(i => i.message).join(", ")}`);
            return;
        }
        const config = mergedResult.data;

        /** @type {string[]} */
        const paths = parsed.paths.map((p) => p.trim()).filter((p) => p.length > 0);
        /** @type {[string, string][]} */
        const entries = await Promise.all(
            paths.map(async (path) => {
                const content = await term.fs.readFile(path, { encoding: "utf8" });
                return [path, content];
            }),
        );

        uploadFiles(entries, term, config);

        if (parsed.watch) {
            const isMatch = picomatch(paths);
            /** @type {(e: CustomEvent) => Promise<void>} */
            const handler = async (e) => {
                const changedPath = /** @type {any} */ (e).detail?.path;
                if (!changedPath || !isMatch(changedPath)) return;
                const content = await term.fs.readFile(changedPath, { encoding: "utf8" });
                uploadFiles([[changedPath, content]], term, config);
            };
            term.addEventListener("fs:modified", handler);
            const stopBtn = document.createElement("button");
            stopBtn.textContent = "⏹ stop watching";
            stopBtn.addEventListener("click", () => {
                term.removeEventListener("fs:modified", handler);
                stopBtn.remove();
            });
            term.log(stopBtn);
        }
    },

});

/**
 *
 * @param {[string,string][]} files
 * @param {WebTerminal} term
 * @param {{prefix:string,solution?:string|undefined}} config
 */
async function uploadFiles(files, term, config) {
    const validFiles = files.map((v) => [`${config.prefix}/${v[0]}`, v[1]]).filter((v) => isValidWebResource(v[0]));
    if (!validFiles.length) return

    const line = term.log(`Uploading ${validFiles.map((v) => v[0]).join(",")}`);

    const wrs = await Promise.all(
        validFiles.map(([name, content]) => uploadWebResource(name, content, config.solution)),
    );
    line.innerHTML += `<span style="color:#4ec9b0">● uploaded</span>`;
    term.dispatchEvent(
        new CustomEvent("dataverse:uploaded", {
            detail: {
                files,
            },
        }),
    );
    await publishWebResources(wrs);
    line.innerHTML += `<span style="color:#f48771">● published</span>`;
    term.dispatchEvent(
        new CustomEvent("dataverse:published", {
            detail: {
                files,
            },
        }),
    );
}
