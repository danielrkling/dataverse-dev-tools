import { createCommand } from "../terminal.mjs";
import { object, optional, argument, string, message, formatDocPage, formatMessage } from "@optique/core";

export const help = createCommand({
    name: "help",
    parser: object({
        command: optional(
            argument(string({ metavar: "COMMAND" }), {
                description: message`The command to show details for`,
            }),
        ),
    }),
    aliases: ["?"],
    description: message`Show available commands or details about a specific command`,
    usage: message`help [command]`,
    brief: message`Show available commands or details about a specific command`,
    execute: (args, term) => {
        if (args.command) {
            term.processCommand(`${args.command} --help`);
            return;
        }
        const cmds = Array.from(new Set(term.commands.values())).sort((a, b) => a.name.localeCompare(b.name));
        console.log(cmds);
        const lines = cmds.map((c) => `  ${c.name.padEnd(15)} ${formatMessage(c.description)}`);
        term.info(`Available commands (${cmds.length}):\n${lines.join("\n")}`);
    },
});

export const clear = createCommand({
    name: "clear",
    parser: object({}),
    description: message`Clear the terminal screen desc`,
    brief: message`Clear the terminal screen brief`,
    execute: (_parsed, term) => {
        term.clear();
    },
});
