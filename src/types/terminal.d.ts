/**
 * Type-only declarations for the terminal execution context that commands
 * receive. The concrete implementation is the <web-terminal> LitElement in
 * `components/terminal.mjs`; a .d.ts is used because the element is a class
 * with Lit statics that cannot be referenced cheaply from JSDoc without
 * pulling the whole component (and Lit) into every command's type graph.
 */

import type { WebFileSystem } from "../services/fs.mjs";
import type { CommandRegistry } from "../services/commands.mjs";

/** Attributes applied to the wrapper element of a logged line. */
export type LogAttributes = Record<string, string>;

/** A single live, mutable status line backed by a DOM element. */
export interface StatusLine {
    /** Replace the status label and optionally recolor it. */
    set(label: string, cssClass?: string, color?: string): void;
    /** Update the right-hand detail text. */
    detail(text: string, color?: string): void;
    /** Remove the line from the output. */
    remove(): void;
}

/** The output sink + execution context handed to command `execute`/`executeEffect`. */
export interface Terminal {
    /** Log a line. Strings are HTML-escaped; elements are appended as-is. */
    log(content: string | HTMLElement, attributes?: LogAttributes): HTMLDivElement | null;
    /** Log trusted, pre-built markup the app itself generated. */
    html(markup: string, attributes?: LogAttributes): HTMLDivElement | null;
    /** Informational (blue) line. */
    info(content: string | HTMLElement): HTMLDivElement | null;
    /** Error (red) line. */
    error(content: string | HTMLElement): HTMLDivElement | null;
    /** Success (green) line. */
    success(content: string | HTMLElement): HTMLDivElement | null;
    /** Remove all output. */
    clear(): void;
    /** Active filesystem (workspace fs, OPFS fallback before a folder is opened). */
    fs: WebFileSystem;
    /** The command registry this terminal executes through. */
    commands: CommandRegistry;
    /** Current prompt text. */
    prompt: string;
    /** Execute a command line as if typed by the user. */
    processCommand(text: string): Promise<void>;
    /** Create a live, mutable status line in the output. */
    startLine?(label: string, detail?: string, color?: string): StatusLine;
}
