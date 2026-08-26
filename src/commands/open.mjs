import { argument, message, object, optional, string } from "@optique/core";
import { createCommand } from "../terminal.mjs";
import { workspace } from "../services/workspace.mjs";

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
        terminal.info("Open a new or recent directory. Provide a name to reopen a recent folder, or run with no arguments to pick one.");
    },
});

// Re-exports kept for backwards compatibility — new code should import from
// services/workspace.mjs directly.
export { saveHandle, getHandle, listHandles, deleteHandle } from "../services/workspace.mjs";
