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
    }

    return args;
}
