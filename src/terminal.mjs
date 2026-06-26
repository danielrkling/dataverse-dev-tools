export class WebTerminal extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        /**@type {(args: string[], console: WebTerminal) => any} */
        this._handlers = new Set();
        this._history = [];
        this._historyIndex = -1;

        // --- Create the component's internal structure and styling ---
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: flex;
                    flex-direction: column;
                    font-family: 'Consolas', 'Monaco', monospace;
                    background-color: #1e1e1e;
                    color: #d4d4d4;
                    padding: 1rem;
                    border-radius: 5px;
                    min-height: 200px; /* Or set via external CSS */
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
                /* Custom Scrollbar Styling */
                #output::-webkit-scrollbar {
                    width: 8px;
                }
                #output::-webkit-scrollbar-track {
                    background: #2d2d2d; /* Darker track */
                    border-radius: 10px;
                }
                #output::-webkit-scrollbar-thumb {
                    background: #555; /* Medium grey thumb */
                    border-radius: 10px;
                }
                #output::-webkit-scrollbar-thumb:hover {
                    background: #777; /* Lighter grey on hover */
                }

                #output  button {
                    all: unset;
                    display: block;
                    width:100%;
                    box-sizing: border-box;
                }

                #output button:hover {
                    background: #555; /* Lighter grey on hover */
                    cursor: pointer;
                }
                #output button:active, #output button:focus-visible {
                    background: #555; /* Lighter grey on hover */
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
                .log-error { color: #f48771; }
            </style>
            <div id="output"></div>
            <div class="input-line">
                <span class="prompt"><span id="prompt"></span>&gt</span>
                <input type="text" id="input" autocomplete="off" />
            </div>
        `;

        this._output = this.shadowRoot.querySelector("#output");
        /** @type {HTMLInputElement} */
        this._input = this.shadowRoot.querySelector("#input");
        this._prompt = this.shadowRoot.querySelector("#prompt");
    }

    connectedCallback() {
        this._input.addEventListener("keydown", (e) => this._onKeyDown(e));
        this.addEventListener("click", (e) => {
            if (window.getSelection().toString() !== "") return;

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
     * Public API to register a command.
     * @param {(args: string[], console: WebTerminal) => any} handler - The function to execute.
     */
    register(handler) {
        this._handlers.add(handler);
    }

    /**
     * Public API to log a message to the console.
     * It appends the content and returns the container element for future manipulation.
     * @param {string|HTMLElement} content - The string, HTML string, or HTMLElement to log.
     * @param {Record<HTMLCollectionOf,elemenm>} [{}] - A CSS class for the log entry container.
     * @returns {HTMLDivElement} The container div element for the new log entry.
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
        this._output.scrollTop = this._output.scrollHeight; // Auto-scroll
        return line;
    }

    clear() {
        this._output.innerHTML = "";
    }

    get prompt() {
        return this._prompt.textContent;
    }

    set prompt(text) {
        this._prompt.textContent = text;
    }

    // --- Internal Methods ---

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

    async _processCommand(text) {
        const args = parseCommandWithQuotes(text);
        const name = args[0];
        for (const handler of this._handlers) {
            try {
                const result = handler(args, this);

                // If the command is async, it might return a promise.
                // We await it in case it returns a final value to be logged.
                if (result instanceof Promise) {
                    const promiseResult = await result;
                    if (promiseResult !== undefined) {
                        this.log(promiseResult);
                        return;
                    }
                } else if (result !== undefined) {
                    // For sync commands that return a simple value
                    this.log(result);
                    return;
                }
                // Note: Generators are now handled entirely within the command logic itself.
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

/**
 * Parses a command string into an array of arguments, respecting single and double quotes.
 *
 * @param {string} text The raw command string to parse.
 * @returns {string[]} An array of arguments.
 *
 * @example
 * parseCommandWithQuotes('npm install "my package" --save');
 * // Returns: ['npm', 'install', 'my package', '--save']
 *
 * @example
 * parseCommandWithQuotes("echo 'hello world' \"and you\"");
 * // Returns: ['echo', 'hello world', 'and you']
 */
export function parseCommandWithQuotes(text) {
    const args = [];
    let currentArg = "";
    let inQuote = null; // Can be null, "'", or '"'

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inQuote) {
            // --- We are inside a quote ---
            if (char === inQuote) {
                // Closing quote found, push the argument and reset state
                args.push(currentArg);
                currentArg = "";
                inQuote = null;
            } else {
                // Just a regular character inside the quote
                currentArg += char;
            }
        } else {
            // --- We are not inside a quote ---
            if (char === '"' || char === "'") {
                // Starting a new quote
                if (currentArg) {
                    // Push the argument collected so far (e.g., the command name)
                    args.push(currentArg);
                    currentArg = "";
                }
                inQuote = char;
            } else if (char === " ") {
                // Space is a delimiter
                if (currentArg) {
                    args.push(currentArg);
                    currentArg = "";
                }
                // Ignore multiple spaces
            } else {
                // Just a regular character
                currentArg += char;
            }
        }
    }

    // After the loop, push any remaining argument
    if (currentArg) {
        args.push(currentArg);
    }

    // Handle the case where the string ends with an empty quoted argument, e.g., `command ""`
    // The loop would have pushed an empty `currentArg` already. This checks for an unclosed quote.
    if (inQuote) {
        console.warn("Unclosed quote in command:", text);
        // Depending on desired behavior, you might want to throw an error
        // or push the unfinished argument. We'll just warn for now.
    }

    return args;
}
