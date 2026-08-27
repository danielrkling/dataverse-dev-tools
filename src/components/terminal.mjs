import { LitElement, html as litHtml, css } from "lit";
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
        // Fallback filesystem (OPFS) until a real workspace folder is opened.
        this._opfsFs = null;
        WebFileSystem.fromOPFS().then((fs) => {
            this._opfsFs = fs;
        });
        /** Command registry lives in services/commands.mjs; this element is
         *  the output sink + execution context for commands. */
        this.registry = new CommandRegistry();
    }

    static styles = [css`
        :host {
            display: flex;
            flex-direction: column;
            font-family: 'Consolas', 'Monaco', monospace;
            background-color: #1e1e1e;
            color: #d4d4d4;
            padding: 1rem;
            border-radius: 5px;
            /* Fill the split-panel slot; let the panel control sizing.
               min-height:0 is required so the host can shrink below
               content height inside a flex column. */
            height: 100%;
            min-height: 0;
            box-sizing: border-box;
        }
        #output {
            flex-grow: 1;
            /* min-height:0 lets the scroll area shrink and scroll
               instead of expanding to fit all the log lines. */
            min-height: 0;
            overflow-y: auto;
            overflow-x: hidden;
            white-space: pre-wrap;
            word-break: break-all;
        }
        #output::-webkit-scrollbar { width: 8px; }
        #output::-webkit-scrollbar-track { background: #2d2d2d; border-radius: 10px; }
        #output::-webkit-scrollbar-thumb { background: #555; border-radius: 10px; }
        #output::-webkit-scrollbar-thumb:hover { background: #777; }
        #output button {
            all: unset;
            display: block;
            width: 100%;
            box-sizing: border-box;
        }
        #output button:hover { background: #555; cursor: pointer; }
        #output button:active, #output button:focus-visible { background: #555; cursor: pointer; }
        .input-line {
            display: flex;
            align-items: center;
            margin-top: 0.5rem;
        }
        .prompt { margin-right: 0.5rem; color: #569cd6; }
        #input {
            flex-grow: 1;
            background: none;
            border: none;
            color: inherit;
            font-family: inherit;
            font-size: 1em;
            outline: none;
        }
        .log-echo { color: #a0a0a0; }
        .log-info { color: #4fc1ff; }
        .log-error { color: #f48771; }
        .log-success { color: #4ec9b0; }
    `];

    render() {
        return litHtml`
            <div id="output"></div>
            <div class="input-line">
                <span class="prompt"><span id="prompt">${this.prompt}</span>&gt</span>
                <input
                    type="text"
                    id="input"
                    autocomplete="off"
                    ?disabled=${this._disabled}
                    placeholder=${this._placeholder}
                    @keydown=${(e) => this._onKeyDown(e)}
                />
            </div>
        `;
    }

    firstUpdated() {
        this.addEventListener("click", (e) => {
            if (window.getSelection()?.toString() !== "") return;

            const path = e.composedPath();

            const clickedFocusable = path.some(
                (el) =>
                    el instanceof HTMLElement &&
                    (el.matches("button, input, textarea, select, a[href]") || el.tabIndex >= 0),
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
        this.info("No folder open — use the folder button in the sidebar to open one.");
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
        const line = document.createElement("div");
        Object.entries(attributes).forEach(([name, value]) => line.setAttribute(name, value));

        if (content instanceof HTMLElement) {
            line.appendChild(content);
        } else {
            line.textContent = String(content);
        }

        const output = /** @type {HTMLDivElement} */ (this.renderRoot.querySelector("#output"));
        output.appendChild(line);
        output.scrollTop = output.scrollHeight;
        return line;
    }

    /**
     * Log trusted, pre-built HTML. Only use this for markup the app itself
     * generated — never interpolate user input or file contents into it.
     * @param {string} markup
     * @param {Record<string, string>} [attributes]
     * @returns {HTMLDivElement}
     */
    html(markup, attributes = {}) {
        return this.log(/** @type {any} */ (document.createRange().createContextualFragment(markup)), attributes);
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

    /** Clear all terminal output */
    clear() {
        const output = /** @type {HTMLDivElement} */ (this.renderRoot.querySelector("#output"));
        output.innerHTML = "";
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
     * @param {import("./commands.mjs").TerminalCommand<TParser>} cmd
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
