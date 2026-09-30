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
 *   const group = yield* Effect.sync(() => ui.startGroup("Uploading:", "a.js, b.js"));
 *   // ... work ...
 *   yield* Effect.sync(() => group.set("Uploaded:", "log-success"));
 */
import { Context, Layer } from "effect";

/**
 * A live collapsible status group (one terminal line that updates in place,
 * with a collapsed <details> body accumulating detail logs). Groups started
 * with the same `id` reuse a single card: re-appended at the bottom of the
 * output with a cleared body, so long watch sessions stay bounded.
 * @typedef {{
 *     set: (label: string, cssClass?: string, color?: string) => void,
 *     detail: (text: string, color?: string) => void,
 *     log: (text: string) => void,
 *     fail: () => void,
 *     remove: () => void,
 * }} StatusGroup
 */

/**
 * A pinned watcher strip row (always visible above the terminal input).
 * @typedef {{
 *     set: (state: "building"|"ok"|"error"|"stopped", detail?: string) => void,
 *     setStop: (onStop: () => void | Promise<void>) => void,
 *     remove: () => void,
 * }} Watcher
 */

/**
 * @typedef {{
 *     startGroup: (label: string, detail?: string, color?: string, id?: string) => StatusGroup,
 *     startWatcher: (id: string, label: string) => Watcher,
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
    /** Reusable status cards keyed by their <details> element (id → node). */
    const cards = new Map();
    return Layer.succeed(TerminalUi, /** @type {TerminalUiImpl} */ ({
        /**
         * A collapsible chain-status group: a live <summary> line that
         * updates in place plus a collapsed body that accumulates detail
         * log lines. One terminal line per run; expand for the details.
         *
         * When an `id` is given, a card with that id is reused instead of
         * creating a new one: the existing <details> element is moved to
         * the bottom of the output and its body cleared — watch loops stay
         * bounded to one card per pipeline.
         *
         * @param {string} label
         * @param {string} [detail]
         * @param {string} [color]
         * @param {string} [id] stable identity; same id reuses the same card
         * @returns {StatusGroup}
         */
        startGroup(label, detail = "", color = "#ccc", id) {
            /** @type {HTMLDetailsElement|undefined} */
            let existing;
            if (id) {
                existing = cards.get(id);
            }
            if (existing) {
                // Re-anchor the card to the bottom of the output (appending
                // an element moves it) and reset it for the next run.
                term.log(existing);
                const summary = /** @type {HTMLElement} */ (existing.querySelector("summary"));
                const status = /** @type {HTMLElement} */ (summary.firstChild);
                const fileList = /** @type {HTMLElement} */ (summary.lastChild);
                const body = /** @type {HTMLElement} */ (existing.querySelector("div"));
                body.replaceChildren();
                status.innerText = label.padEnd(12);
                status.className = "";
                status.style.color = color;
                fileList.innerText = detail;
                fileList.style.color = color;
                existing.open = false;
                return groupHandle(existing, status, fileList, body);
            }

            const details = document.createElement("details");
            details.style.cssText = "margin:2px 0;";
            if (id) details.dataset.cardId = id;
            const summary = document.createElement("summary");
            summary.style.cssText = "cursor:pointer;list-style:none;";
            const status = document.createElement("span");
            status.innerText = label.padEnd(12);
            const fileList = document.createElement("span");
            fileList.innerText = detail;
            fileList.style.color = color;
            summary.append(status, fileList);
            const body = document.createElement("div");
            body.style.cssText = "padding:2px 0 2px 14px;font-size:0.92em;opacity:0.85;";
            details.append(summary, body);
            term.log(details);
            if (id) cards.set(id, details);

            return groupHandle(details, status, fileList, body);
        },

        /**
         * Create (or reuse) a pinned watcher strip row via the terminal's
         * watcher registry — the DOM lives in the <web-terminal> element.
         *
         * @param {string} id
         * @param {string} label
         * @returns {Watcher}
         */
        startWatcher(id, label) {
            return term.watcher?.(id, label) ?? { set() {}, setStop() {}, remove() {} };
        },
    }));
}

/**
 * Build the StatusGroup handle for a card's DOM parts.
 *
 * @param {HTMLDetailsElement} details
 * @param {HTMLElement} status
 * @param {HTMLElement} fileList
 * @param {HTMLElement} body
 * @returns {StatusGroup}
 */
function groupHandle(details, status, fileList, body) {
    return {
        /** Replace the status word and optionally recolor it. */
        set(newLabel, cssClass, newColor) {
            status.innerText = newLabel.padEnd(12);
            if (cssClass) status.className = cssClass;
            if (newColor) status.style.color = newColor;
        },
        /** Update the right-hand detail text on the summary. */
        detail(text, newColor) {
            fileList.innerText = text;
            if (newColor) fileList.style.color = newColor;
        },
        /** Append a detail line inside the collapsed body. */
        log(text) {
            const row = document.createElement("div");
            row.textContent = text;
            body.append(row);
        },
        /** Auto-open on failure so errors are visible. */
        fail() {
            details.open = true;
        },
        remove() {
            details.remove();
        },
    };
}
