/**
 * Terminal command registry — the service side of the terminal.
 *
 * Owns the command table and argv processing (&& / & grouping). The
 * <web-terminal> element (components/terminal.mjs) delegates to this and
 * provides the output sink (log/info/error) plus the execution context that
 * commands receive as their second `execute()` argument.
 */
import parseArgs from "string-argv";
import { runParser } from "@optique/core";
import { Effect, Duration, Cause, Exit } from "effect";
import { withTerminalLogger } from "../effects/logger.mjs";
import { commandLayers } from "../effects/services.mjs";

/**
 * @template {import("@optique/core").Parser<any>} TParser
 * @typedef {object} TerminalCommand
 * @property {string} name
 * @property {[string, ...string[]]} [aliases]
 * @property {import("@optique/core").Message} description
 * @property {import("@optique/core").Message} [usage]
 * @property {import("@optique/core").Message} [brief]
 * @property {TParser} parser
 * @property {(args: import("@optique/core").InferValue<TParser>, terminal: any) => any | Promise<any>} [execute]
 * @property {(args: import("@optique/core").InferValue<TParser>, terminal: any) => import("effect").Effect.Effect<any, any, any>} [executeEffect]
 *        Effect-based execution. Typed errors become the command's
 *        contract; run via Effect with terminal logging, context service
 *        layers (TerminalSink/WorkspaceFs/DataverseApi), a span per
 *        invocation, and a 60s timeout. Takes precedence over `execute`.
 * @property {(terminal: any) => void} [init]
 * @property {(args: string[]) => string[]} [transformArgs]
 * @property {number} [timeoutSeconds]
 *        Per-command Effect timeout for executeEffect runs (default 60).
 *        Set higher for long local operations (git/npm scans over the
 *        File System Access API) or 0 to disable entirely.
 */

/**
 * @template {import("@optique/core").Parser<any>} TParser
 * @param {TerminalCommand<TParser>} command
 */
export function createCommand(command) {
    return command;
}

/**
 * Split an argv array into serial groups (`&&`) and parallel commands (`&`).
 * @param {string[]} argv
 * @returns {string[][][]} serial groups of parallel commands
 */
export function splitCommands(argv) {
    const serialGroups = [];
    let currentParallel = [];
    let currentCmd = [];

    for (const token of argv) {
        if (token === "&&") {
            if (currentCmd.length > 0) {
                currentParallel.push(currentCmd);
                currentCmd = [];
            }
            if (currentParallel.length > 0) {
                serialGroups.push(currentParallel);
                currentParallel = [];
            }
        } else if (token === "&") {
            if (currentCmd.length > 0) {
                currentParallel.push(currentCmd);
                currentCmd = [];
            }
        } else {
            currentCmd.push(token);
        }
    }
    if (currentCmd.length > 0) {
        currentParallel.push(currentCmd);
    }
    if (currentParallel.length > 0) {
        serialGroups.push(currentParallel);
    }

    return serialGroups;
}

/**
 * Registry of terminal commands. `term` is the output sink / execution
 * context — anything with `log`, `info`, `error` methods (today: WebTerminal).
 */
export class CommandRegistry {
    constructor() {
        /** @type {Map<string, TerminalCommand<any>>} */
        this.commands = new Map();
    }

    /** Unique registered commands (aliases deduped), sorted by name. @returns {TerminalCommand<any>[]} */
    values() {
        return [...new Set(this.commands.values())];
    }

    /** @returns {IterableIterator<string>} */
    keys() {
        return this.commands.keys();
    }

    /**
     * @template {import("@optique/core").Parser<any>} TParser
     * @param {TerminalCommand<TParser>} cmd
     * @param {any} term output sink + execute context
     */
    registerCommand(cmd, term) {
        this.commands.set(cmd.name, cmd);
        if (cmd.aliases) {
            for (const alias of cmd.aliases) {
                this.commands.set(alias, cmd);
            }
        }
        cmd.init?.(term);
    }

    /**
     * Parse and run a full command line (supports `&&` and `&`).
     * @param {string} text
     * @param {any} term
     */
    async processCommand(text, term) {
        const args = parseArgs(text);
        const groups = splitCommands(args);

        if (groups.length === 1 && groups[0].length === 1) {
            const [name, ...cmdArgs] = groups[0][0];
            await this._execCommand(name, cmdArgs, term);
        } else {
            for (const parallelCmds of groups) {
                await Promise.all(
                    parallelCmds.map((cmd) => this.processCommand(cmd.join(" "), term)),
                );
            }
        }
    }

    /**
     * @param {string} name
     * @param {string[]} cmdArgs
     * @param {any} term
     */
    async _execCommand(name, cmdArgs, term) {
        const command = this.commands.get(name);

        if (!command) {
            term.log(`Command not found: ${name}`, { class: "log-error" });
            return;
        }

        try {
            if (command.transformArgs) {
                cmdArgs = command.transformArgs(cmdArgs);
            }

            /** @type {import("@optique/core/program").Program<any,any>} */
            const program = ({
                parser: command.parser,
                metadata: { name: command.name, brief: command.brief, description: command.description },
            });

            const result = runParser(program, cmdArgs, {
                help: {
                    option: true,
                    onShow: () => false,
                },
                stdout: (v) => term.info(v),
                stderr: (v) => term.error(v),
            });

            if (result) {
                if (command.executeEffect) {
                    /** Effect-based execution: span, timeout, context layers, terminal logging. */
                    let effect = command.executeEffect(result, term).pipe(
                        Effect.withSpan(`cmd.${command.name}`),
                        Effect.provide(commandLayers(term)),
                    );
                    // Per-command timeout; 0 opts out (long local scans).
                    const timeoutSeconds = command.timeoutSeconds ?? 60;
                    if (timeoutSeconds > 0) {
                        effect = Effect.timeout(effect, Duration.seconds(timeoutSeconds));
                    }
                    const exit = await Effect.runPromiseExit(withTerminalLogger(effect, term));
                    if (Exit.isSuccess(exit)) {
                        if (exit.value !== undefined && exit.value !== null) term.log(exit.value);
                    } else {
                        // Typed/plain Errors print as a single friendly line;
                        // defects (unexpected crashes) keep full Cause.pretty.
                        const failure = Cause.failureOption(exit.cause);
                        const message = /** @type {any} */ (failure)?.message;
                        if (typeof message === "string" && message.length > 0) {
                            term.log(message, { class: "log-error" });
                        } else {
                            term.log(Cause.pretty(exit.cause), { class: "log-error" });
                        }
                    }
                    return;
                }
                const executeResult = await Effect.runPromise(
                    withTerminalLogger(
                        Effect.tryPromise({
                            // Promise.resolve: sync-void executes (echo, help,
                            // clear) return undefined, not a Promise.
                            try: () => Promise.resolve(command.execute?.(result, term)),
                            catch: (cause) => cause,
                        }),
                        term,
                    ),
                );
                if (executeResult) term.log(executeResult);
            }
        } catch (error) {
            term.log(error.message, { class: "log-error" });
            console.error(`Error executing command '${name}':`, error);
        }
    }
}
