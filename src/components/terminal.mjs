import { LitElement, html as litHtml, css } from "lit";
import { hostStyles, scrollbarStyles, theme } from "./shared-styles.mjs";
import { WebFileSystem } from "../services/fs.mjs";
import { workspace, } from "../services/workspace.mjs";
import { bus } from "../services/bus.mjs";
import { CommandRegistry } from "../services/commands.mjs";
import { saveCommandHistory, loadCommandHistory, clearCommandHistory } from "../utils/history.mjs";

/**
 * <web-terminal>: LitElement with shadow DOM. The static shell (styles,
 * output area, input line) is Lit-templated; log output is appended
 * imperatively for speed (commands may emit hundreds of lines).
 *
 * Command registration/execution lives in services/commands.mjs — this
 * element is the output sink + execution context commands receive.
 */
export class WebTerminal extends LitElement {
    /** Reactive: rendered into the prompt span. */
    static properties = {
        prompt: { state: true },
        _disabled: { state: true },
        _placeholder: { state: true },
    };

    constructor() {
        super();
        this.prompt = "";
        this._disabled = true;
        this._placeholder = "";
        /** @type {Set<(args: string[], term: WebTerminal) => any>} */
        this._handlers = new Set();
        /** @type {string[]} */
        this._history = [];
        /** @type {number} */
        this._historyIndex = -1;
        /** @type {(() => void)[]} */
        this._unsubs = [];
        /** @type {{ content: string | HTMLElement, attributes: Record<string, string> }[]} log lines emitted before first render */
        this._pendingLogs = [];
        // Fallback filesystem (OPFS) until a real workspace folder is opened.
        this._opfsFs = null;
        WebFileSystem.fromOPFS().then((fs) => {
            this._opfsFs = fs;
        });
        /** Command registry lives in services/commands.mjs; this element is
         *  the output sink + execution context for commands. */
        this.registry = new CommandRegistry();
    }

    // :host fills the split-panel slot; min-height:0 lets it shrink below
    // content height inside a flex column (panel controls sizing).
    static styles = [
        hostStyles,
        scrollbarStyles,
        css`
            :host { padding: 1rem; border-radius: 5px; height: 100%; }
            /* min-height:0 lets the scroll area shrink and scroll instead of
               expanding to fit all the log lines. */
            #output { flex-grow: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; white-space: pre-wrap; word-break: break-all; }
            #output button {
                all: unset;
                display: block;
                width: 100%;
                box-sizing: border-box;
            }
            #output button:hover,
            #output button:active,
            #output button:focus-visible { background: #555; cursor: pointer; }
            .input-line { display: flex; align-items: center; flex-wrap: nowrap; margin-top: 0.5rem; }
            /* Prompt never shrinks; input takes the rest (min-width:0 lets it
               shrink within the flex row instead of wrapping). */
            .prompt { margin-right: 0.5rem; color: ${theme.accent}; white-space: nowrap; flex-shrink: 0; }
            #input { flex-grow: 1; min-width: 0; background: none; border: none; color: inherit; font-family: inherit; font-size: 1em; outline: none; }
            .log-echo { color: ${theme.textDim}; }
            .log-info, [data-disabled-hint] { color: ${theme.info}; }
            [data-disabled-hint] { margin-bottom: 0.5rem; }
            .log-error { color: ${theme.error}; }
            .log-success { color: ${theme.success}; }
            :host summary:focus,
            :host summary:focus-visible { outline: none; }

            /* Pinned watcher status strip (#2): one row per active watcher,
               always visible above the input without scrolling. */
            #watchers { flex-shrink: 0; display: flex; flex-direction: column; gap: 2px; border-top: 1px solid #333; padding: 6px 0 0; margin-top: 0.5rem; }
            #watchers[hidden] { display: none; }
            .watcher { display: flex; align-items: center; gap: 0.5rem; font-size: 0.92em; }
            .watcher .dot { width: 8px; height: 8px; border-radius: 50%; background: #666; flex-shrink: 0; }
            .watcher[data-state="building"] .dot { background: ${theme.accent}; animation: watcher-pulse 1s ease-in-out infinite; }
            .watcher[data-state="ok"] .dot { background: ${theme.success}; }
            .watcher[data-state="error"] .dot { background: ${theme.error}; }
            .watcher-label { color: ${theme.info}; }
            .watcher-detail { color: ${theme.textDim}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            @keyframes watcher-pulse { 50% { opacity: 0.35; } }
        `,
    ];

    render() {
        return litHtml`
            <div id="output"></div>
            <div id="watchers" hidden></div>
            <div class="input-line">
                <span class="prompt"><span id="prompt">${this.prompt}</span>&gt</span>
                <input
                    type="text"
                    id="input"
                    autocomplete="off"
                    ?disabled=${this._disabled}
                    placeholder=${this._placeholder}
                    @keydown=${(/** @type {KeyboardEvent} */ e) => this._onKeyDown(e)}
                />
            </div>
        `;
    }

    firstUpdated() {
        // Flush any log lines emitted before the first render created #output.
        const pending = this._pendingLogs.splice(0);
        for (const { content, attributes } of pending) this.log(content, attributes);

        this.addEventListener("click", (e) => {
            if (window.getSelection()?.toString() !== "") return;

            const path = e.composedPath();

            // Only real interactive controls keep the input unfocused. Note
            // <summary> is deliberately NOT in this list: clicking a
            // collapsible group toggles it AND returns focus to the input
            // (summary elements are natively focusable, so a broader
            // tabIndex-based check here used to steal focus from the prompt).
            const clickedFocusable = path.some(
                (el) =>
                    el instanceof HTMLElement &&
                    el.matches("button, input, textarea, select, a[href]"),
            );

            if (!clickedFocusable) {
                this._inputEl()?.focus();
            }
        });

        // The terminal is inert until a workspace folder is opened. React to
        // that event (emitted by workspace.open, regardless of caller).
        this._unsubs.push(bus.on("workspace:open", () => this._enable()));

        // If a folder is already open (e.g. restored before connect), enable.
        if (workspace.fs) {
            this._enable();
        } else {
            this._disable();
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
    }

    /** @returns {HTMLInputElement} */
    _inputEl() {
        return /** @type {HTMLInputElement} */ (this.renderRoot.querySelector("#input"));
    }

    /** Lock the terminal out until a workspace folder is selected. */
    _disable() {
        this._disabled = true;
        this._placeholder = "Open a folder to use the terminal…";
        this.prompt = "";
        // The "no folder open" hint is rendered reactively in the template
        // (data-disabled-hint) and disappears when _disabled flips back.
    }

    /** Unlock the terminal once a workspace folder is available. */
    _enable() {
        this._disabled = false;
        this._placeholder = "";
        // Wipe the "no folder open" hint now that a folder is loaded.
        this.clear();
        if (workspace.fs) {
            this.prompt = workspace.fs.rootName;
            this.loadHistory(workspace.fs.rootName);
        }
    }

    /**
     * Log a message to the terminal output. String content is rendered as
     * plain text (HTML-escaped), so user input can never inject markup.
     * @param {string|HTMLElement} content
     * @param {Record<string, string>} [attributes]
     * @returns {HTMLDivElement}
     */
    log(content, attributes = {}) {
        const output = /** @type {HTMLDivElement} */ (this.renderRoot.querySelector("#output"));
        // Commands may log during registration, before the first Lit render
        // has created #output — queue those lines and flush on firstUpdated.
        if (!output) {
            this._pendingLogs.push({ content, attributes });
            return /** @type {any} */ (null);
        }
        const line = document.createElement("div");
        Object.entries(attributes).forEach(([name, value]) => line.setAttribute(name, value));

        if (content instanceof HTMLElement) {
            line.appendChild(content);
        } else {
            line.textContent = String(content);
        }

        output.appendChild(line);
        output.scrollTop = output.scrollHeight;
        return line;
    }

    /**
     * Log an informational message (blue).
     * @param {string|HTMLElement} content
     * @returns {HTMLDivElement}
     */
    info(content) {
        return this.log(content, { class: "log-info" });
    }

    /**
     * Log an error message (red).
     * @param {string|HTMLElement} content
     * @returns {HTMLDivElement}
     */
    error(content) {
        return this.log(content, { class: "log-error" });
    }

    /**
     * Log a success message (green).
     * @param {string|HTMLElement} content
     * @returns {HTMLDivElement}
     */
    success(content) {
        return this.log(content, { class: "log-success" });
    }

    /** Clear all terminal output (and any pinned watcher rows). */
    clear() {
        const output = /** @type {HTMLDivElement} */ (this.renderRoot.querySelector("#output"));
        output.innerHTML = "";
        const watchers = /** @type {HTMLElement} */ (this.renderRoot.querySelector("#watchers"));
        if (watchers) {
            watchers.replaceChildren();
            watchers.hidden = true;
        }
    }

    /**
     * Upsert a pinned watcher status row (the strip above the input).
     * One row per watcher id; calling again with the same id reuses it.
     *
     * @param {string} id stable watcher identity (e.g. "esbuild-watch")
     * @param {string} label human-readable name shown after the dot
     * @returns {{ set: (state: "building"|"ok"|"error"|"stopped", detail?: string) => void, remove: () => void }}
     */
    watcher(id, label) {
        const holder = /** @type {HTMLElement} */ (this.renderRoot.querySelector("#watchers"));
        if (!holder) {
            return { set() {}, remove() {} };
        }
        let row = /** @type {HTMLElement} */ (holder.querySelector(`.watcher[data-id="${CSS.escape(id)}"]`));
        if (!row) {
            row = document.createElement("div");
            row.className = "watcher";
            row.dataset.id = id;
            const dot = document.createElement("span");
            dot.className = "dot";
            const name = document.createElement("span");
            name.className = "watcher-label";
            name.textContent = label;
            const detail = document.createElement("span");
            detail.className = "watcher-detail";
            row.append(dot, name, detail);
            holder.append(row);
            holder.hidden = false;
        }
        const dot = /** @type {HTMLElement} */ (row.querySelector(".dot"));
        const detailEl = /** @type {HTMLElement} */ (row.querySelector(".watcher-detail"));
        return {
            /** @param {string} state @param {string} [detail] */
            set(state, detail = "") {
                row.dataset.state = state;
                dot.title = state;
                detailEl.textContent = detail;
                detailEl.title = detail;
            },
            remove() {
                row.remove();
                if (!holder.children.length) holder.hidden = true;
            },
        };
    }

    /**
     * The active filesystem. Reads from the workspace service; falls back to
     * OPFS before a workspace folder is opened. Kept as a getter for
     * backwards compatibility with commands that do `terminal.fs.*`.
     * @type {WebFileSystem}
     */
    get fs() {
        return /** @type {WebFileSystem} */ (workspace.fs ?? this._opfsFs);
    }

    /** @param {WebFileSystem} fs */
    set fs(fs) {
        workspace.fs = fs;
        this._opfsFs = fs;
    }

    /** @returns {string} */
    _historyKey() {
        return this.fs?.rootName || '_default';
    }

    /** @returns {Promise<void>} */
    async _persistHistory() {
        await saveCommandHistory(this._historyKey(), this._history);
    }

    /**
     * @param {string} key
     * @returns {Promise<string[]>}
     */
    async loadHistory(key) {
        const h = await loadCommandHistory(key);
        this._history = h;
        this._historyIndex = -1;
        return h;
    }

    // --- Internal Methods ---

    /**
     * @param {KeyboardEvent} event
     */
    _onKeyDown(event) {
        const input = this._inputEl();
        switch (event.key) {
            case "Enter":
                event.preventDefault();
                const text = input.value.trim();
                if (text) {
                    this._history.unshift(text);
                    this._historyIndex = -1;
                    this._persistHistory();
                    this.log(`${this.prompt}> ${text}`, { class: "log-echo" });
                    input.value = "";
                    this.processCommand(text);
                }
                break;
            case "ArrowUp":
                event.preventDefault();
                if (this._historyIndex < this._history.length - 1) {
                    this._historyIndex++;
                    input.value = this._history[this._historyIndex];
                }
                break;
            case "ArrowDown":
                event.preventDefault();
                if (this._historyIndex > 0) {
                    this._historyIndex--;
                    input.value = this._history[this._historyIndex];
                } else {
                    this._historyIndex = -1;
                    input.value = "";
                }
                break;
        }
    }

    /** @type {Map<string, import("../services/commands.mjs").TerminalCommand<any>>} Registry view (delegated). */
    get commands() {
        return this.registry.commands;
    }

    /**
     * @template {import("@optique/core").Parser<any>} TParser
     * @param {import("../services/commands.mjs").TerminalCommand<TParser>} cmd
     */
    registerCommand(cmd) {
        this.registry.registerCommand(cmd, this);
    }

    /**
     * @param {string} text
     */
    async processCommand(text) {
        await this.registry.processCommand(text, this);
    }
}

customElements.define("web-terminal", WebTerminal);
