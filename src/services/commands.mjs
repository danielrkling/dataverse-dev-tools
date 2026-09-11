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
import { WorkspaceFs, commandLayers } from "../effects/services.mjs";

/**
 * @template {import("@optique/core").Parser<any>} TParser
 * @typedef {object} TerminalCommand
 * @property {string} name
 * @property {[string, ...string[]]} [aliases]
 * @property {import("@optique/core").Message} description
 * @property {import("@optique/core").Message} [usage]
 * @property {import("@optique/core").Message} [brief]
 * @property {TParser} parser
 * @property {(args: import("@optique/core").InferValue<TParser>, terminal: any) => import("effect").Effect.Effect<any, any, any>} executeEffect
 *        Effect-based execution — the only execution path. Typed errors
 *        become the command's contract; run via Effect with terminal
 *        logging, context service layers (TerminalSink/WorkspaceFs/
 *        DataverseApi), a span per invocation, and a 60s timeout (tunable
 *        via `timeoutSeconds`). Returning `undefined`/`null` logs nothing;
 *        any other result value is printed via `term.log`.
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

// ---------------------------------------------------------------------------
// Shared command helpers
//
// Concrete helpers reused across src/commands/*.mjs: the typed fs-failure
// machinery (error factory / fsOp / describeCause / span pipeline), the
// stack-stripped friendly error, JSON-config loading with zod issue
// reporting, and the watch-mode stop button. Keeping them here preserves
// import direction: commands may import from services/.
// ---------------------------------------------------------------------------

/**
 * Describe an fs failure cause for the terminal (one line, no stack noise).
 * @param {unknown} cause
 * @returns {string}
 */
export function describeFsCause(cause) {
    const msg =
        cause instanceof Error
            ? cause.message
            : /** @type {any} */ (cause)?.message ?? String(cause);
    return msg || "unknown error";
}

/**
 * Build a typed fs error factory with a caller-chosen tag (e.g. "FsError",
 * "FlattenFsError"). The returned factory takes the operation + path and
 * yields a `catch` handler carrying the original cause.
 *
 * @template {string} TTag
 * @param {TTag} tag
 * @returns {(op: string, path: string) => (cause: unknown) => { _tag: TTag, op: string, path: string, cause: unknown }}
 */
export function makeFsError(tag) {
    return (op, path) => (cause) => ({
        _tag: tag,
        op,
        path,
        cause,
    });
}

/**
 * Structural shape shared by fs error factories — loose on `_tag` so
 * differently-tagged factories (FsError, FlattenFsError, …) all satisfy it.
 * @typedef {{ _tag: string, op: string, path: string, cause: unknown }} FsErrorLike
 */

/**
 * Canonical typed fs failure — carries the operation and path so error
 * mapping can produce a single friendly line per command.
 * @typedef {{ _tag: "FsError", op: string, path: string, cause: unknown }} FsError
 */

/**
 * Error factory for {@link FsError}.
 * @param {string} op
 * @param {string} path
 * @returns {(cause: unknown) => FsError}
 */
export const FsError = makeFsError("FsError");

/**
 * Build an `fsOp` bound to an error factory: run a filesystem operation
 * against the WorkspaceFs service, tagging any rejection with the factory's
 * typed error.
 *
 * @template A
 * @template E
 * @param {(op: string, path: string) => (cause: unknown) => E} makeError
 * @returns {<A>(op: string, path: string, run: (fs: import("../types/services.d.ts").WorkspaceFsService) => Promise<A>) => Effect.Effect<A, E, any>}
 */
export function makeFsOp(makeError) {
    return (op, path, run) =>
        Effect.flatMap(WorkspaceFs, (fs) =>
            Effect.tryPromise({
                try: () => run(fs),
                catch: (cause) => makeError(op, path)(cause),
            }),
        );
}

/**
 * Final pipeline for an fs command: per-command span (with the mandatory
 * log span), then map the typed {@link FsErrorLike} error to a plain
 * Error so the registry's Cause.pretty output shows a single friendly
 * message.
 *
 * @template A
 * @param {string} name span name, e.g. "fs.ls" or "flatten.run"
 * @param {Record<string, string>} attributes span attributes (e.g. { path })
 * @returns {(effect: Effect.Effect<A, FsErrorLike, any>) => Effect.Effect<A, Error>}
 */
export function withFsSpan(name, attributes) {
    return (effect) =>
        /** @type {Effect.Effect<A, Error>} */ (
            effect.pipe(
                Effect.withSpan(name, { attributes }),
                Effect.withLogSpan(name),
                Effect.mapError(
                    (e) => new Error(`${e.op} '${e.path}': ${describeFsCause(e.cause)}`),
                ),
            )
        );
}

/**
 * Friendly single-line error for the registry's Cause.pretty output
 * (stack stripped so the terminal shows one line, not a trace).
 *
 * @param {string} message
 * @param {{ stack?: unknown }} [options] stack value to record after
 *        stripping (default `null`).
 * @returns {Error}
 */
export function friendlyError(message, options) {
    const e = new Error(message);
    /** @type {any} */ (e).stack = options?.stack ?? null;
    return e;
}

/**
 * Load and parse a JSON config file, tagging failures with the canonical
 * {@link FsError} (`op: "readFile"` / `"parse"`, path = configPath). A
 * missing/unreadable file is tolerated when not required and yields `{}`,
 * matching the original command-level helpers.
 *
 * @param {string} configPath
 * @param {{ required?: boolean }} [options]
 * @returns {Effect.Effect<unknown, FsError, any>}
 */
export function readJsonConfigEffect(configPath, options) {
    const required = options?.required ?? false;
    return Effect.gen(function* () {
        const fs = yield* WorkspaceFs;
        const content = yield* Effect.tryPromise({
            try: () => fs.readFile(configPath, { encoding: "utf8" }),
            catch: FsError("readFile", configPath),
        });
        return yield* Effect.try({
            try: () => JSON.parse(/** @type {string} */ (content)),
            catch: FsError("parse", configPath),
        });
    }).pipe(
        required ? Effect.mapError((e) => e) : Effect.catchAll(() => Effect.succeed({})),
    );
}

/**
 * Join a zod error's issues into the one-line message the config commands
 * print to the terminal.
 *
 * @param {import("zod").ZodError} error
 * @returns {string}
 */
export function zodIssuesMessage(error) {
    return error.issues.map((i) => i.message).join(", ");
}

/**
 * The "⏹ stop watching" button shown by watch-mode commands: unsubscribes
 * an event listener, stops the watch pipeline, optionally disposes the
 * build context, and removes itself.
 *
 * @param {{ term: any, pipeline: { stop: () => void }, unsub: () => void,
 *          onDispose?: (() => unknown) | null }} options
 *        `term` is the output sink (must accept `log`); `onDispose` is extra
 *        teardown (e.g. dispose an esbuild watch context).
 */
/**
 * Append a "⏹ stop watching" button that unwinds a watch pipeline.
 *
 * @param {{
 *     term: any,
 *     pipeline: { push: (event: any) => void, stop: () => Promise<void> },
 *     unsub: () => void,
 *     onDispose?: () => void,
 *     onStopped?: () => void,   // runs after the pipeline fiber is done
 * }} options
 */
export function createStopWatchButton({ term, pipeline, unsub, onDispose, onStopped }) {
    const stopBtn = document.createElement("button");
    stopBtn.textContent = "⏹ stop watching";
    stopBtn.addEventListener("click", async () => {
        onDispose?.();
        unsub();
        stopBtn.disabled = true;
        // Wait for the fiber so a rebuild in flight can't touch the UI
        // (e.g. flip a watcher row) after the button already resolved.
        await pipeline.stop();
        stopBtn.remove();
        onStopped?.();
    });
    term.log(stopBtn);
}

/**
 * Split an argv array into serial groups (`&&`) and parallel commands (`&`).
 * @param {string[]} argv
 * @returns {string[][][]} serial groups of parallel commands
 */
function splitCommands(argv) {
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
            }
        } catch (error) {
            term.log(error.message, { class: "log-error" });
            console.error(`Error executing command '${name}':`, error);
        }
    }
}
