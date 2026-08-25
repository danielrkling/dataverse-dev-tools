import { argument, message, object, optional, string } from "@optique/core";
import { createCommand } from "../terminal.mjs";
import { workspace, listHandles } from "../services/workspace.mjs";

export const openCommand = createCommand({
    name: "open",
    aliases: ["o"],
    description: message`Open new or recent directory`,
    usage: message`open [<folder_name>]`,
    brief: message`Open new or recent directory`,
    parser: object({
        path: optional(
            argument(string({ metavar: "PATH" }), {
                description: message`Recent Directory to open`,
            }),
        ),
    }),
    execute: async (parsed, terminal) => {
        if (parsed.path) {
            await workspace.openRecent(parsed.path, terminal);
        } else {
            const opened = await workspace.openPicker(terminal);
            if (!opened) {
                terminal.error(`Invalid permissions`);
            }
        }
    },
    init: async (terminal) => {
        const recentFolders = await listHandles();
        const elem = document.createElement("div");
        elem.append(`Select a recent folder or open a new one`);

        for (const folder of recentFolders) {
            const button = document.createElement("button");
            button.innerText = `  ${folder.id}`;

            button.onclick = async () => {
                await workspace.openRecent(folder.id, terminal);
                elem.innerHTML = "";
            };
            elem.appendChild(button);
        }

        const button = document.createElement("button");
        button.innerText = "  Select New Folder";
        button.onclick = async () => {
            await workspace.openPicker(terminal);
            elem.innerHTML = "";
        };
        elem.appendChild(button);

        terminal.log(elem);
    },
});

// Re-exports kept for backwards compatibility — new code should import from
// services/workspace.mjs directly.
export { saveHandle, getHandle, listHandles, deleteHandle } from "../services/workspace.mjs";
