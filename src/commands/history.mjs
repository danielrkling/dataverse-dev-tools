import { createCommand } from "../terminal.mjs";
import { clearCommandHistory } from "../utils/history.mjs";
import { object, message, option, integer, string, optional } from "@optique/core";

export const historyCommand = createCommand({
  name: "history",
  aliases: ["hist"],
  description: message`Show or clear command history for the current folder`,
  usage: message`history [--clear] [-n N]`,
  brief: message`Show or clear command history`,
  parser: object({
    clear: optional(option("--clear", { description: message`Clear the command history for this folder` })),
    n: option("-n", integer({ metavar: "N" }), { description: message`Show last N entries` }),
  }),
  execute: async (parsed, term) => {
    const key = term.fs?.rootName || '_default';

    if (parsed.clear) {
      term._history = [];
      term._historyIndex = -1;
      await clearCommandHistory(key);
      await term._persistHistory();
      term.success(`Command history cleared for "${key}"`);
      return;
    }

    const h = term._history;
    if (h.length === 0) {
      term.info("No commands in history.");
      return;
    }

    const limit = parsed.n || h.length;
    const entries = h.slice(0, Math.min(limit, h.length));
    const lines = entries.map(/** @param {string} c */ (c, i) => `  ${i + 1}  ${c}`);
    term.log(`${key} command history (${entries.length}/${h.length} shown):\n${lines.join("\n")}`);
  },
});
