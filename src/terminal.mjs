import { parseCommandWithQuotes } from "./parser.mjs";

export class WebTerminal extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        /** @type {Set<(args: string[], term: WebTerminal) => any>} */
        this._handlers = new Set();
        /** @type {string[]} */
        this._history = [];
        /** @type {number} */
        this._historyIndex = -1;

        const root = /** @type {ShadowRoot} */ (this.shadowRoot);
        root.innerHTML = `
            <style>
                :host {
                    display: flex;
                    flex-direction: column;
                    font-family: 'Consolas', 'Monaco', monospace;
                    background-color: #1e1e1e;
                    color: #d4d4d4;
                    padding: 1rem;
                    border-radius: 5px;
                    min-height: 200px;
                    max-height: 100vh;
                    height:100%;
                    box-sizing: border-box;
                }
                #output {
                    flex-grow: 1;
                    overflow-y: auto;
                    white-space: pre-wrap;
                    word-break: break-all;
                }
                #output::-webkit-scrollbar {
                    width: 8px;
                }
                #output::-webkit-scrollbar-track {
                    background: #2d2d2d;
                    border-radius: 10px;
                }
                #output::-webkit-scrollbar-thumb {
                    background: #555;
                    border-radius: 10px;
                }
                #output::-webkit-scrollbar-thumb:hover {
                    background: #777;
                }

                #output  button {
                    all: unset;
                    display: block;
                    width:100%;
                    box-sizing: border-box;
                }

                #output button:hover {
                    background: #555;
                    cursor: pointer;
                }
                #output button:active, #output button:focus-visible {
                    background: #555;
                    cursor: pointer;
                }

                .input-line {
                    display: flex;
                    align-items: center;
                    margin-top: 0.5rem;
                }
                .prompt {
                    margin-right: 0.5rem;
                    color: #569cd6;
                }
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
            </style>
            <div id="output"></div>
            <div class="input-line">
                <span class="prompt"><span id="prompt"></span>&gt</span>
                <input type="text" id="input" autocomplete="off" />
            </div>
        `;

        this._output = /** @type {HTMLDivElement} */ (root.querySelector("#output"));
        this._input = /** @type {HTMLInputElement} */ (root.querySelector("#input"));
        this._prompt = /** @type {HTMLSpanElement} */ (root.querySelector("#prompt"));
        /** @type {((args: string[], term: WebTerminal) => any) | null} */
        this._dispatchHandler = null;
    }

    /**
     * Set a single dispatch handler that takes over command processing.
     * When set, this handler is called instead of iterating registered handlers.
     * @param {(args: string[], term: WebTerminal) => any} handler
     */
    setDispatchHandler(handler) {
        this._dispatchHandler = handler;
    }

    connectedCallback() {
        this._input.addEventListener("keydown", (e) => this._onKeyDown(e));
        this.addEventListener("click", (e) => {
            if (window.getSelection()?.toString() !== "") return;

            const path = e.composedPath();

            const clickedFocusable = path.some(
                (el) =>
                    el instanceof HTMLElement &&
                    (el.matches("button, input, textarea, select, a[href]") || el.tabIndex >= 0),
            );

            if (!clickedFocusable) {
                this._input.focus();
            }
        });
        this.register((args) => {
            if (args[0] === "clear") {
                this.clear();
                return "";
            }
        });
    }

    /**
     * Public API to register a command handler.
     * @param {(args: string[], console: WebTerminal) => any} handler
     */
    register(handler) {
        this._handlers.add(handler);
    }

    /**
     * Log a message to the terminal output.
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
            line.innerHTML = String(content);
        }

        this._output.appendChild(line);
        this._output.scrollTop = this._output.scrollHeight;
        return line;
    }

    /**
     * Log an informational message (blue).
     * @param {string|HTMLElement} content
     * @returns {HTMLDivElement}
     */
    info(content) {
        return this.log(content, { class: 'log-info' });
    }

    /**
     * Log an error message (red).
     * @param {string|HTMLElement} content
     * @returns {HTMLDivElement}
     */
    error(content) {
        return this.log(content, { class: 'log-error' });
    }

    /**
     * Log a success message (green).
     * @param {string|HTMLElement} content
     * @returns {HTMLDivElement}
     */
    success(content) {
        return this.log(content, { class: 'log-success' });
    }

    /** Clear all terminal output */
    clear() {
        this._output.innerHTML = "";
    }

    /** @returns {string} */
    get prompt() {
        return this._prompt.textContent ?? '';
    }

    /** @param {string} text */
    set prompt(text) {
        this._prompt.textContent = text;
    }

    // --- Internal Methods ---

    /**
     * @param {KeyboardEvent} event
     */
    _onKeyDown(event) {
        switch (event.key) {
            case "Enter":
                event.preventDefault();
                const text = this._input.value.trim();
                if (text) {
                    this._history.unshift(text);
                    this._historyIndex = -1;
                    this.log(`${this.prompt}> ${text}`, { class: "log-echo" });
                    this._input.value = "";
                    this._processCommand(text);
                }
                break;
            case "ArrowUp":
                event.preventDefault();
                if (this._historyIndex < this._history.length - 1) {
                    this._historyIndex++;
                    this._input.value = this._history[this._historyIndex];
                }
                break;
            case "ArrowDown":
                event.preventDefault();
                if (this._historyIndex > 0) {
                    this._historyIndex--;
                    this._input.value = this._history[this._historyIndex];
                } else {
                    this._historyIndex = -1;
                    this._input.value = "";
                }
                break;
        }
    }

    /**
     * @param {string} text
     */
    async _processCommand(text) {
        const args = parseCommandWithQuotes(text);
        const name = args[0] || '';

        if (this._dispatchHandler) {
            try {
                const result = await this._dispatchHandler(args, this);
                if (result !== undefined) {
                    this.log(String(result));
                }
            } catch (error) {
                this.log(error.message, { class: 'log-error' });
                console.error(`Error executing command '${name}':`, error);
            }
            return;
        }

        for (const handler of this._handlers) {
            try {
                const result = handler(args, this);

                if (result instanceof Promise) {
                    const promiseResult = await result;
                    if (promiseResult !== undefined) {
                        this.log(promiseResult);
                        return;
                    }
                } else if (result !== undefined) {
                    this.log(result);
                    return;
                }
            } catch (error) {
                this.log(error.message, { class: "log-error" });
                console.error(`Error executing command '${name}':`, error);
            }
        }

        this.log(`Command not found: ${name}`, { class: "log-error" });
        return;
    }
}

customElements.define("web-terminal", WebTerminal);
