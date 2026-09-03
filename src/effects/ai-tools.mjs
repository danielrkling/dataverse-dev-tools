/**
 * TanStack AI tools generated from the command registry.
 *
 * Every registered command becomes a tool the model can call:
 * - inputSchema: Zod (Standard Schema) — TanStack AI native
 * - execute: runs the command through the registry (Optique parsing +
 *   executeEffect/execute pipeline), wrapped in an Effect span + timeout
 * - output: structured { success, output } — errors become readable tool
 *   results so the model can react, instead of raw stack traces
 */
import { z } from "zod";
import { toolDefinition } from "@tanstack/ai";
import { Effect, Duration } from "effect";
import { formatMessage } from "@optique/core";
import { withTerminalLogger } from "./logger.mjs";
import { commandLayers } from "./services.mjs";

/**
 * @typedef {import("../services/commands.mjs").CommandRegistry} CommandRegistry
 */

/** Commands that are meaningless for an AI agent to call. */
const EXCLUDED = new Set(["help", "clear", "history"]);

/** Capture timeout for a single tool execution. */
const TOOL_TIMEOUT_MS = 30_000;

/**
 * Build an output-capturing proxy around the terminal so tool results come
 * back to the model instead of only scrolling the terminal.
 * @param {any} term
 */
function captureSink(term) {
    /** @type {string[]} */
    const lines = [];
    const capture = (/** @type {any} */ msg) => {
        if (msg == null) return;
        if (typeof msg === "string") lines.push(msg);
        else if (msg instanceof Node) lines.push(msg.textContent ?? "");
        else lines.push(String(msg));
    };
    return {
        /** Capturing sink — never forwards to the real terminal. */
        proxy: {
            log: (/** @type {any} */ m) => capture(m),
            info: (/** @type {any} */ m) => capture(m),
            error: (/** @type {any} */ m) => capture(m),
            // Structural bits the commands may touch during execution:
            fs: term.fs,
            processCommand: term.processCommand?.bind(term),
            commands: term.commands,
            prompt: term.prompt,
            clear: () => {},
        },
        text: () => lines.join("\n"),
    };
}

/**
 * Create TanStack AI tool definitions for all registered commands.
 *
 * @param {CommandRegistry} registry
 * @param {any} term the terminal execution context
 * @returns {Array<ReturnType<typeof toolDefinition>>} tool definitions
 */
export function createToolsFromRegistry(registry, term) {
    /** @type {any[]} */
    const tools = [];
    const seen = new Set();

    for (const cmd of registry.commands.values()) {
        if (seen.has(cmd.name) || EXCLUDED.has(cmd.name)) continue;
        seen.add(cmd.name);

        const description = cmd.description
            ? formatMessage(cmd.description)
            : `${cmd.name} command`;
        const usage = cmd.usage ? formatMessage(cmd.usage) : undefined;

        tools.push(
            toolDefinition({
                name: cmd.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
                description: usage ? `${description}\nUsage: ${usage}` : description,
                inputSchema: z.object({
                    args: z
                        .string()
                        .default("")
                        .describe(
                            "Command-line arguments to pass after the command name, e.g. '--watch' or 'src/app.js'. Omit for no arguments.",
                        ),
                }),
                outputSchema: z.object({
                    success: z.boolean(),
                    output: z.string(),
                }),
            }).server(async (/** @type {{ args?: string }} */ { args }) => {
                const sink = captureSink(term);
                const cmdArgs = (typeof args === "string" ? args : "").trim();
                    const effect = Effect.tryPromise({
                        try: () => registry.processCommand(`${cmd.name} ${cmdArgs}`.trim(), sink.proxy),
                        catch: (cause) => ({
                            _tag: "CommandError",
                            message: /** @type {any} */ (cause)?.message ?? String(cause),
                            cause,
                        }),
                    }).pipe(
                        Effect.withSpan(`ai.tool.${cmd.name}`, {
                            attributes: { args },
                        }),
                        Effect.timeoutFail({
                            duration: Duration.millis(TOOL_TIMEOUT_MS),
                            onTimeout: () => ({
                                _tag: "ToolTimeout",
                                message: `${cmd.name} timed out after ${TOOL_TIMEOUT_MS / 1000}s`,
                            }),
                        }),
                        Effect.provide(commandLayers(term)),
                    );

                    const exit = await Effect.runPromiseExit(withTerminalLogger(effect, term));
                    const output = sink.text();
                    if (exit._tag === "Failure") {
                        const msg =
                            /** @type {any} */ (exit.cause)?.failure?.message ??
                            String(/** @type {any} */ (exit.cause).failure ?? exit.cause);
                        return { success: false, output: output || msg };
                    }
                    return { success: true, output: output || "(no output)" };
                }),
        );
    }
    return /** @type {any} */ (tools);
}
