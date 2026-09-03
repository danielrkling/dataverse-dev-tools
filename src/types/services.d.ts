/**
 * Type-only declarations for the Effect service tags in effects/services.mjs.
 * No runtime code — the tags themselves are created with Context.GenericTag in
 * that module and cast to these shapes, recovering Effect's R-channel typing
 * (what `yield* Tag` produces) without TS-generic syntax in .mjs files.
 */

import type { Terminal } from "./terminal.d.ts";

/** The human-facing output sink handed to every command. */
export type TerminalSinkService = Terminal;

/**
 * The workspace file system surface used by commands (services/fs.mjs
 * WebFileSystem). Paths are workspace-relative; `cwd` is the terminal's
 * current directory.
 */
export interface WorkspaceFsService {
    cwd: string;
    rootName: string;
    exists(path: string): Promise<boolean>;
    readFile(path: string, options?: { encoding?: string } | string): Promise<string | ArrayBuffer>;
    writeFile(path: string, data: string | ArrayBuffer | ArrayBufferView, options?: { encoding?: string } | string): Promise<void>;
    unlink(path: string): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rmdir(path: string, options?: Record<string, unknown>): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    readdir(path: string, options?: { types?: boolean }): Promise<string[] | [string, string][]>;
    /** Change the terminal working directory; returns the new cwd. */
    cd(path: string): Promise<string>;
    stat(path: string): Promise<{
        isDirectory: unknown;
        isFile: unknown;
        /** FS-Handle style kind, when the adapter provides it. */
        type?: string;
        size?: number;
        mtime?: Date;
        mtimeMs?: number;
    }>;
    /** Collect [relativePath, content] pairs matching an optional matcher. */
    getFilesFromDirectory(
        prefix: string,
        match?: (path: string) => boolean,
    ): Promise<[string, string][]>;
}
