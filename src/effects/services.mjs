/**
 * Effect services (Context.Tags) for the execution context that used to be
 * the untyped `term` object.
 *
 * Tags are created with Context.GenericTag (the JSDoc-friendly pattern —
 * the `class X extends Context.Tag("X")<Shape>() {}` idiom requires TS
 * generics syntax that is invalid in .mjs files).
 *
 * The registry's `commandLayers(term)` provides all of them per command run.
 */
import { Context, Layer } from "effect";
import { DataverseServiceLive } from "./dataverse-service.mjs";

/**
 * Terminal output sink — the human-facing side of command execution.
 * @type {Context.Tag<"TerminalSink", any>}
 */
export const TerminalSink = Context.GenericTag("TerminalSink");

/**
 * The active workspace file system (services/fs.mjs WebFileSystem).
 * @type {Context.Tag<"WorkspaceFs", any>}
 */
export const WorkspaceFs = Context.GenericTag("WorkspaceFs");

/**
 * Build all context layers for a command execution from the `term` object.
 *
 * @param {any} term terminal sink / execution context
 * @returns {Layer.Layer<any, never, never>} merged context layers
 */
export function commandLayers(term) {
    return Layer.mergeAll(
        Layer.succeed(TerminalSink, term),
        Layer.succeed(WorkspaceFs, term?.fs ?? {}),
        DataverseServiceLive,
    );
}
