/**
 * Effect services (Context.Tags) for the execution context that used to be
 * the untyped `term` object.
 *
 * Tags are created with Context.GenericTag (the JSDoc-friendly pattern —
 * the `class X extends Context.Tag("X")<Shape>() {}` idiom requires TS
 * generics syntax that is invalid in .mjs files) and cast to the interfaces
 * in types/services.d.ts, so `yield* WorkspaceFs` yields a fully typed
 * WorkspaceFsService and the R-channel is tracked by tsc.
 *
 * The registry's `commandLayers(term)` provides all of them per command run —
 * commands should declare requirements, never provide these themselves.
 */
import { Context, Layer } from "effect";
import { DataverseServiceLive } from "./dataverse-service.mjs";
import { terminalUiLayer } from "./terminal-ui.mjs";

/**
 * Terminal output sink — the human-facing side of command execution.
 * @type {import("effect").Context.Tag<"TerminalSink", import("../types/services.d.ts").TerminalSinkService>}
 */
export const TerminalSink = /** @type {any} */ (Context.GenericTag("TerminalSink"));

/**
 * The active workspace file system (services/fs.mjs WebFileSystem).
 * @type {import("effect").Context.Tag<"WorkspaceFs", import("../types/services.d.ts").WorkspaceFsService>}
 */
export const WorkspaceFs = /** @type {any} */ (Context.GenericTag("WorkspaceFs"));

/**
 * Build all context layers for a command execution from the `term` object.
 * This is THE layer graph for command runs — if a service needs to reach a
 * command, provide it here (exception: GitStatusLive stays local to git.mjs
 * because services/git-status.mjs imports commands/git.mjs, and adding it
 * here would create an import cycle).
 *
 * @param {any} term terminal sink / execution context
 * @returns {Layer.Layer<any, never, never>} merged context layers
 */
export function commandLayers(term) {
    return Layer.mergeAll(
        Layer.succeed(TerminalSink, term),
        Layer.succeed(WorkspaceFs, /** @type {any} */ (term?.fs ?? {})),
        terminalUiLayer(term),
        DataverseServiceLive,
    );
}
