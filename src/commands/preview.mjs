import { createCommand } from "../terminal.mjs";
import { object, optional, argument, string, message, option } from "@optique/core";

/** @type {Set<Window>} */
const previewWindows = new Set();

/** @param {Window} win */
function registerPreviewWindow(win) {
    previewWindows.add(win);
}

const previewParser = object({
    path: optional(
        argument(string({ metavar: "PATH" }), {
            description: message`Web resource path to preview`,
        }),
    ),
    onUpload: option("--upload", "-u"),
    onPublish: option("--publish", "-p"),
});

export const previewCommand = createCommand({
    name: "preview",
    parser: previewParser,
    aliases: ["pv"],
    description: message`Preview a web resource in a new tab`,
    usage: message`preview [path]`,
    brief: message`Preview a web resource in a new tab`,
    execute: async (parsed, term) => {
        let path = parsed.path;
        const { fs } = term;

        if (!path) {
            try {
                const config = JSON.parse(
                    /** @type {string} */ (await fs.readFile("dataverse.config.json", { encoding: "utf8" })),
                );
                path = config.upload?.preview;
            } catch {
                return "No preview path configured and no path provided.";
            }
        }
        if (!path) return "Could not determine preview path.";
        const url = `${location.origin}/WebResources/${path}`;
        const win = window.open(url);

        if (parsed.onPublish) {
            const refresh = () => {
                try {
                    //@ts-expect-error
                    win.location.reload();
                } catch {
                    term.removeEventListener("dataverse:published", refresh);
                }
            };
            term.addEventListener("dataverse:published", refresh);
        }
        if (parsed.onUpload) {
            const refresh = () => {
                try {
                    //@ts-expect-error
                    win.location.reload();
                } catch {
                    term.removeEventListener("dataverse:uploaded", refresh);
                }
            };
            term.addEventListener("dataverse:uploaded", refresh);
        }

        return `Opening ${url}`;
    },
});
