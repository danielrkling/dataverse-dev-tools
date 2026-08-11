import { message, object } from "@optique/core";
import { createCommand } from "../terminal.mjs";

export const editCommand = createCommand({
    name: "edit",
    aliases: ["e"],
    description: message`Open the file editor in a new tab`,
    usage: message`edit`,
    brief: message`Open the file editor in a new tab`,
    parser: object({}),
    execute: async (_parsed, terminal) => {
        if (!terminal.fs) {
            return "No folder open. Use 'open' first.";
        }
        window.open("src/editor/editor.html");
        return "Opening editor...";
    },
});
