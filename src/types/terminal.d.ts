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

/** The output sink + execution context handed to command `execute`/`executeEffect`. */
export interface Terminal {
    /** Log a line. Strings are HTML-escaped; elements are appended as-is. */
    log(content: string | HTMLElement, attributes?: LogAttributes): HTMLDivElement | null;
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
    /** Upsert a pinned watcher status row (strip above the input). */
    watcher(id: string, label: string): {
        set(state: "building" | "ok" | "error" | "stopped", detail?: string): void;
        remove(): void;
    };
}
