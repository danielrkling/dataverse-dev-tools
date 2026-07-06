import { command, message, or, parse, runParser } from "@optique/core";
import parseArgs from "string-argv";
import { WebFileSystem } from "./fs.mjs";


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
        WebFileSystem.fromOPFS().then((fs) => {
            this.fs = fs;
        });

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
        this._output.innerHTML = "";
    }

    /** @returns {string} */
    get prompt() {
        return this._prompt.textContent ?? "";
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
                    this.processCommand(text);
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

    /** @type {Map<string, TerminalCommand<import("@optique/core").Parser<any>>>} */
    commands = new Map();

    /**
     * @template {import("@optique/core").Parser<any>} TParser
     * @param {TerminalCommand<TParser>} cmd
     */
    registerCommand(cmd) {
        this.commands.set(cmd.name, cmd);
        if (cmd.aliases) {
            for (const alias of cmd.aliases) {
                this.commands.set(alias, cmd);
            }
        }
        cmd.init?.(this);
    }

    /**
     * @param {string} text
     */
    async processCommand(text) {
        const args = parseArgs(text);
        const name = args[0] || "";

        const command = this.commands.get(name);

        if (command) {
            try {
                
                /** @type {import("@optique/core/program").Program<any,any>} */
                const program = ({
                    parser: command.parser,
                    metadata: { name: command.name, brief: command.brief, description: command.description },
                });

                const result = runParser(program, args.slice(1), {
                    help: {
                        // Enable help functionality
                        option: true, // Enable --help option
                        onShow: () => false,
                    },
                    stdout: (v) => this.info(v),
                    stderr: (v) => this.error(v),
                });

                if (result) {
                    const executeResult = await command.execute(result, this);
                    if (executeResult) this.log(executeResult);
                }
            } catch (error) {
                this.log(error.message, { class: "log-error" });
                console.error(`Error executing command '${name}':`, error);
            }
        } else {
            this.log(`Command not found: ${name}`, { class: "log-error" });
        }
    }
}

customElements.define("web-terminal", WebTerminal);

/**
 * @template {import("@optique/core").Parser<any>} TParser
 * @typedef {object} TerminalCommand
 * @property {string} name
 * @property {[string, ...string[]]} [aliases]
 * @property {import("@optique/core").Message} description
 * @property {import("@optique/core").Message} [usage]
 * @property {import("@optique/core").Message} [brief]
 * @property {TParser} parser
 * @property {(args: import("@optique/core").InferValue<TParser>, terminal: WebTerminal) => string | undefined | Promise<string | undefined>} execute
 * @property {(terminal: WebTerminal) => void} [init]
 */

/**
 * @template {import("@optique/core").Parser<any>} TParser
 * @param {TerminalCommand<TParser>} command
 */
export function createCommand(command) {
    return command;
}
