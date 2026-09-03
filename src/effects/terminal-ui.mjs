/**
 * TerminalUi — an Effect service for mutable terminal widgets.
 *
 * Effect's Logger is append-only and must not be used for live UI
 * (log events cannot be updated or recolored after emission). Live
 * widgets — status lines whose text/color change as work progresses —
 * belong in a service that hands out handles backed by DOM elements.
 *
 * Usage:
 *   const ui = yield* TerminalUi;
 *   const line = yield* Effect.sync(() => ui.startLine("Uploading:", "a.js, b.js"));
 *   // ... work ...
 *   yield* Effect.sync(() => line.set("Uploaded:", "log-success"));
 */
import { Context, Layer } from "effect";

/**
 * A live status line in the terminal.
 * @typedef {{
 *     set: (label: string, cssClass?: string, detail?: string) => void,
 *     detail: (text: string, color?: string) => void,
 *     remove: () => void,
 * }} StatusLine
 */

/**
 * @typedef {{
 *     startLine: (label: string, detail?: string, color?: string) => StatusLine,
 * }} TerminalUiImpl
 */

/**
 * @type {Context.Tag<"TerminalUi", TerminalUiImpl>}
 */
export const TerminalUi = Context.GenericTag("TerminalUi");

/**
 * Build the TerminalUi layer for a terminal sink.
 *
 * @param {any} term terminal sink (term.log accepts DOM nodes)
 * @returns {Layer.Layer<any, never, never>}
 */
export function terminalUiLayer(term) {
    return Layer.succeed(TerminalUi, /** @type {TerminalUiImpl} */ ({
        /**
         * @param {string} label
         * @param {string} [detail]
         * @param {string} [color]
         */
        startLine(label, detail = "", color = "#ccc") {
            const line = document.createElement("div");
            const status = document.createElement("span");
            status.innerText = label.padEnd(12);
            const fileList = document.createElement("span");
            fileList.innerText = detail;
            fileList.style.color = color;
            line.append(status, fileList);
            term.log(line);

            return {
                /** Replace the status word and optionally recolor it. */
                set(newLabel, cssClass, newColor) {
                    status.innerText = newLabel.padEnd(12);
                    if (cssClass) status.className = cssClass;
                    if (newColor) status.style.color = newColor;
                },
                /** Update the right-hand detail text. */
                detail(text, newColor) {
                    fileList.innerText = text;
                    if (newColor) fileList.style.color = newColor;
                },
                remove() {
                    line.remove();
                },
            };
        },
    }));
}
