import { createCommand } from "../services/commands.mjs";
import { Effect } from "effect";
import { WorkspaceFs } from "../effects/services.mjs";
import { clearCommandHistory } from "../utils/history.mjs";
import { object, message, option, integer, optional } from "@optique/core";

export const historyCommand = createCommand({
  name: "history",
  aliases: ["hist"],
  description: message`Show or clear command history for the current folder`,
  usage: message`history [--clear] [-n N]`,
  brief: message`Show or clear command history`,
  parser: object({
    clear: optional(option("--clear", { description: message`Clear the command history for this folder` })),
    n: optional(option("-n", integer({ metavar: "N" }), { description: message`Show last N entries` })),
  }),
  /**
   * @param {{ clear?: boolean, n?: number }} parsed
   * @param {import("../types/terminal.d.ts").Terminal} term
   * @returns {Effect.Effect<void, Error, any>}
   */
  executeEffect: (parsed, term) =>
    Effect.gen(function* () {
      const fs = /** @type {any} */ (yield* WorkspaceFs);
      const key = fs?.rootName || "_default";

      if (parsed.clear) {
        /** @type {any} */ (term)._history = [];
        /** @type {any} */ (term)._historyIndex = -1;
        yield* Effect.tryPromise({
          try: () => clearCommandHistory(key),
          catch: (/** @type {unknown} */ cause) => ({
            _tag: /** @type {const} */ ("HistoryClearError"),
            key,
            cause,
          }),
        });
        yield* Effect.tryPromise({
          try: () => /** @type {any} */ (term)._persistHistory(),
          catch: (/** @type {unknown} */ cause) => ({
            _tag: /** @type {const} */ ("HistoryPersistError"),
            key,
            cause,
          }),
        });
        term.success(`Command history cleared for "${key}"`);
        return;
      }

      const h = /** @type {string[]} */ (/** @type {any} */ (term)._history ?? []);
      if (h.length === 0) {
        term.info("No commands in history.");
        return;
      }

      const limit = parsed.n || h.length;
      const entries = h.slice(0, Math.min(limit, h.length));
      const lines = entries.map(/** @param {string} c @param {number} i */ (c, i) => `  ${i + 1}  ${c}`);
      term.log(`${key} command history (${entries.length}/${h.length} shown):\n${lines.join("\n")}`);
    }).pipe(
      Effect.withSpan("history.run", { attributes: { clear: Boolean(parsed.clear) } }),
      Effect.withLogSpan("history.run"),
      Effect.mapError(
        (/** @type {any} */ e) =>
          new Error(
            e?._tag === "HistoryClearError"
              ? `history: could not clear history for "${e.key}": ${e.cause?.message ?? e.cause}`
              : `history: could not persist history: ${e.cause?.message ?? e.cause}`,
          ),
      ),
    ),
});
