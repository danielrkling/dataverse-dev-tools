import { createCommand } from "../services/commands.mjs";
import { Effect } from "effect";
import { object, optional, argument, string, message, formatMessage, multiple, choice } from "@optique/core";
import { setMinimumLogLevel, getMinimumLogLevel } from "../effects/logger.mjs";

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
    executeEffect: (args, term) =>
        Effect.sync(() => {
            if (args.command) {
                term.processCommand(`${args.command} --help`);
                return undefined;
            }
            const cmds = Array.from(new Set(term.commands.values())).sort((a, b) => a.name.localeCompare(b.name));
            const lines = cmds.map((c) => `  ${c.name.padEnd(15)} ${formatMessage(c.description)}`);
            term.info(`Available commands (${cmds.length}):\n${lines.join("\n")}`);
            return undefined;
        }),
});

export const echo = createCommand({
    name: "echo",
    parser: object({
        args: multiple(argument(string({ metavar: "TEXT" }), {
            description: message`Text to print`,
        })),
    }),
    aliases: ["print"],
    description: message`Print text to the terminal`,
    usage: message`echo [text]`,
    brief: message`Print text to the terminal`,
    executeEffect: (parsed, term) =>
        Effect.sync(() => {
            if (parsed.args) term.log(parsed.args.join(" "));
            return undefined;
        }),
});

export const clear = createCommand({
    name: "clear",
    parser: object({}),
    description: message`Clear the terminal screen desc`,
    brief: message`Clear the terminal screen brief`,
    executeEffect: (_parsed, term) =>
        Effect.sync(() => {
            term.clear();
            return undefined;
        }),
});

export const logLevel = createCommand({
    name: "log-level",
    parser: object({
        level: optional(
            argument(choice(["trace", "debug", "info", "warn", "error", "fatal"]), {
                description: message`Minimum level to show`,
            }),
        ),
    }),
    description: message`Show or set the minimum Effect log level shown in the terminal`,
    usage: message`log-level [trace|debug|info|warn|error|fatal]`,
    brief: message`Show or set the minimum Effect log level`,
    executeEffect: (parsed, term) =>
        Effect.sync(() => {
            if (parsed.level) {
                setMinimumLogLevel(/** @type {any} */ (parsed.level));
                term.info(`Minimum log level set to ${parsed.level}`);
            } else {
                term.info(`Minimum log level: ${getMinimumLogLevel()}`);
            }
            return undefined;
        }),
});