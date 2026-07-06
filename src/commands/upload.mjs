import { uploadWebResource, publishWebResources, isValidWebResource } from "../wr.mjs";
import { createCommand, WebTerminal } from "../terminal.mjs";
import { readJSON } from "../utils/json.mjs";
import { dataverseConfigSchema } from "../utils/schemas.mjs";
import { object, flag, argument, string, message, option, optional } from "@optique/core";
import picomatch from "picomatch";

const uploadParser = object({
    path: argument(string({ metavar: "PATH" }), {
        description: message`File or directory to upload`,
    }),
    prefix: optional(option("-p", "--prefix", string({ metavar: "PREFIX" }))),
    solution: optional(option("-s", "--solution", string({ metavar: "SOLUTION" }))),
});

export const uploadCommand = createCommand({
    name: "upload",
    parser: uploadParser,
    aliases: ["ul"],
    description: message`Upload web resources to Dataverse`,
    usage: message`upload <path> [--publish]`,
    brief: message`Upload web resources to Dataverse`,
    execute: async (parsed, term) => {
        const raw = await term.fs.readFile("dataverse.config.json", { encoding: "utf8" });
        const configFile = (() => {
            const parsed = JSON.parse(raw);
            const result = dataverseConfigSchema.safeParse(parsed);
            if (!result.success) {
                term.error(`dataverse.config.json: ${result.error.issues.map(i => i.message).join(", ")}`);
                return parsed;
            }
            return result.data;
        })();
        const path = parsed.path;


        const content = await term.fs.readFile(path, { encoding: "utf8" });

        const config = {
            ...configFile,
            parsed,
        };

        uploadFiles([[path, content]], term, config);
    },

    init: async (term) => {
        term.addEventListener("fs:modified", async (e) => {
            //@ts-expect-error
            const path = e.detail.path;

            const rawConfig = await term.fs.readFile("dataverse.config.json", { encoding: "utf8" });
            const config = (() => {
                const parsed = JSON.parse(rawConfig);
                const result = dataverseConfigSchema.safeParse(parsed);
                if (!result.success) {
                    term.error(`dataverse.config.json: ${result.error.issues.map(i => i.message).join(", ")}`);
                    return parsed;
                }
                return result.data;
            })();

            const isMatch = picomatch(config.files);
            if (isMatch(path)) {
                const content = await term.fs.readFile(path, { encoding: "utf8" });

                uploadFiles([[path, content]], term, config);
            }
        });

        term.addEventListener("fs:init", async (e) => {
            const rawConfig = await term.fs.readFile("dataverse.config.json", { encoding: "utf8" });
            const config = (() => {
                const parsed = JSON.parse(rawConfig);
                const result = dataverseConfigSchema.safeParse(parsed);
                if (!result.success) {
                    term.error(`dataverse.config.json: ${result.error.issues.map(i => i.message).join(", ")}`);
                    return parsed;
                }
                return result.data;
            })();

            if (!config.files) return;
            if (!config.prefix) return;

            const isMatch = picomatch(config.files);

            const files = await term.fs.getFilesFromDirectory("", isMatch);
            // const filtered = Object.entries(files).filter((v) => isMatch(v[0]));

            uploadFiles(files, term, config);
        });
    },
});

/**
 *
 * @param {[string,string][]} files
 * @param {WebTerminal} term
 * @param {{prefix:string,solution:string}} config
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
