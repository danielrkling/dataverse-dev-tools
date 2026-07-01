import { createCommand } from "../terminal.mjs";
import { object, optional, argument, string, message } from "@optique/core";

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
  description: "Show available commands or details about a specific command",
  usage: "help [command]",
  brief: "Show available commands or details about a specific command",
  execute: (args, term) => {
    if (args.command) {
      const cmdName = args.command;
      const cmd = term.commands.get(cmdName);
      if (cmd) {
        const parts = [`${cmd.name} — ${cmd.description}`];
        if (cmd.usage) parts.push(`Usage: ${cmd.usage}`);
        if (cmd.aliases?.length)
          parts.push(`Aliases: ${cmd.aliases.join(", ")}`);
        term.log(parts.join("\n"));
        return "";
      }
      term.log(`No help found for '${cmdName}'`, { class: "log-error" });
      return "";
    }
    const cmds = Array.from(new Set(term.commands.values())).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const lines = cmds.map((c) => `  ${c.name.padEnd(15)} ${c.description}`);
    term.log(`Available commands (${cmds.length}):\n${lines.join("\n")}`);
    return "";
  },
});

export const clear = createCommand({
  name: "clear",
  parser: object({}),
  description: "Clear the terminal screen",
  brief: "Clear the terminal screen",
  execute: (_parsed, term) => {
    term.clear();
    return "";
  },
});
