import { createCommand } from "../services/commands.mjs";
import { Effect } from "effect";
import { WorkspaceFs } from "../effects/services.mjs";
import {
  object,
  optional,
  argument,
  string,
  option,
  message,
} from "@optique/core";

/**
 * Typed fs failure — carries the operation and path so error mapping can
 * produce a single friendly line per command.
 * @typedef {{ _tag: "FsError", op: string, path: string, cause: unknown }} FsError
 */

/**
 * Error factory for {@link FsError}.
 * @param {string} op
 * @param {string} path
 * @returns {(cause: unknown) => FsError}
 */
export const FsError = (op, path) => (cause) => ({
  _tag: /** @type {const} */ ("FsError"),
  op,
  path,
  cause,
});

/**
 * Run a filesystem operation against the WorkspaceFs service, tagging any
 * rejection with an {@link FsError}.
 *
 * @template A
 * @param {string} op operation name (used for spans and error messages)
 * @param {string} path target path
 * @param {(fs: import("../types/terminal.d.ts").Terminal["fs"]) => Promise<A>} run
 * @returns {Effect.Effect<A, FsError, any>}
 */
const fsOp = (op, path, run) =>
  Effect.flatMap(WorkspaceFs, (fs) =>
    Effect.tryPromise({
      try: () => run(fs),
      catch: FsError(op, path),
    }),
  );

/**
 * Describe an fs failure cause for the terminal (one line, no stack noise).
 * @param {unknown} cause
 */
const describeCause = (cause) => {
  const msg =
    cause instanceof Error
      ? cause.message
      : /** @type {any} */ (cause)?.message ?? String(cause);
  return msg || "unknown error";
};

/**
 * Final pipeline for an fs command: per-command span (with the mandatory
 * log span), then map the typed error to a plain Error so the registry's
 * Cause.pretty output shows a single friendly message.
 *
 * @template A
 * @param {string} name span name, e.g. "fs.ls"
 * @param {string} path attribute path
 * @returns {(effect: Effect.Effect<A, FsError, any>) => Effect.Effect<A, Error>}
 */
const withFsSpan = (name, path) => (effect) => {
  const out = effect.pipe(
    Effect.withSpan(name, { attributes: { path } }),
    Effect.withLogSpan(name),
    Effect.mapError(
      (e) => new Error(`${e.op} '${e.path}': ${describeCause(e.cause)}`),
    ),
  );
  return /** @type {Effect.Effect<A, Error>} */ (out);
};

export const lsCommand = createCommand({
  name: "ls",
  parser: object({
    path: optional(
      argument(string({ metavar: "PATH" }), {
        description: message`Directory path to list`,
      }),
    ),
  }),
  aliases: ["dir"],
  description: message`List directory contents`,
  usage: message`ls [path]`,
  brief: message`List directory contents`,
  /**
   * @param {{ path?: string }} parsed
   * @returns {Effect.Effect<string, Error>}
   */
  executeEffect: (parsed) => {
    const path = parsed.path || ".";
    return Effect.gen(function* () {
      const entries = yield* fsOp("readdir", path, (fs) => fs.readdir(path));
      const stats = yield* Effect.forEach(
        entries,
        (/** @type {string} */ name) => {
          const fullPath = path === "." ? name : `${path}/${name}`;
          return fsOp("stat", fullPath, (fs) => fs.stat(fullPath)).pipe(
            Effect.map((s) => ({ name, isDirectory: s.isDirectory })),
            Effect.catchAll(() => Effect.succeed({ name, isDirectory: false })),
          );
        },
      );
      return stats
        .map((s) => `  ${(s.isDirectory ? "[DIR]" : "[FILE]").padEnd(7)} ${s.name}`)
        .join("\n");
    }).pipe(withFsSpan("fs.ls", path));
  },
});

export const cdCommand = createCommand({
  name: "cd",
  parser: object({
    path: optional(
      argument(string({ metavar: "PATH" }), {
        description: message`Directory path to change to`,
      }),
    ),
  }),
  description: message`Change current directory`,
  usage: message`cd <path>`,
  brief: message`Change current directory`,
  /**
   * @param {{ path?: string }} parsed
   * @param {import("../types/terminal.d.ts").Terminal} term
   * @returns {Effect.Effect<string | undefined, Error>}
   */
  executeEffect: (parsed, term) => {
    const path = parsed.path || ".";
    return /** @type {Effect.Effect<string | undefined, Error>} */ (
      Effect.gen(function* () {
        const fs = yield* WorkspaceFs;
        if (!parsed.path) return fs.cwd;
        const target = /** @type {string} */ (parsed.path);
        const newCwd = yield* fsOp("cd", target, (wfs) => fs.cd(target));
        term.prompt = `${fs.rootName}${newCwd}`;
        return undefined;
      }).pipe(withFsSpan("fs.cd", path))
    );
  },
});

export const pwdCommand = createCommand({
  name: "pwd",
  parser: object({}),
  description: message`Print working directory`,
  brief: message`Print working directory`,
  /** @returns {Effect.Effect<string, never, any>} */
  executeEffect: () =>
    Effect.gen(function* () {
      const fs = yield* WorkspaceFs;
      return fs.cwd;
    }),
});

export const catCommand = createCommand({
  name: "cat",
  parser: object({
    file: argument(string({ metavar: "FILE" }), {
      description: message`File to display`,
    }),
  }),
  description: message`Display file contents`,
  usage: message`cat <file>`,
  brief: message`Display file contents`,
  /**
   * @param {{ file: string }} parsed
   * @returns {Effect.Effect<string, Error>}
   */
  executeEffect: (parsed) =>
    fsOp("readFile", parsed.file, (fs) =>
      fs.readFile(parsed.file, { encoding: "utf8" }),
    ).pipe(
      Effect.map((content) => String(content)),
      withFsSpan("fs.cat", parsed.file),
    ),
});

export const mkdirCommand = createCommand({
  name: "mkdir",
  parser: object({
    path: argument(string({ metavar: "PATH" }), {
      description: message`Directory path to create`,
    }),
  }),
  description: message`Create a directory`,
  usage: message`mkdir <path>`,
  brief: message`Create a directory`,
  /**
   * @param {{ path: string }} parsed
   * @returns {Effect.Effect<void, Error>}
   */
  executeEffect: (parsed) =>
    fsOp("mkdir", parsed.path, (fs) => fs.mkdir(parsed.path, { recursive: true })).pipe(
      Effect.asVoid,
      withFsSpan("fs.mkdir", parsed.path),
    ),
});

export const rmCommand = createCommand({
  name: "rm",
  parser: object({
    r: optional(
      option("-r", {
        description: message`Remove directories and their contents recursively`,
      }),
    ),
    path: argument(string({ metavar: "PATH" }), {
      description: message`File or directory path to remove`,
    }),
  }),
  aliases: ["del", "delete"],
  description: message`Remove a file or directory`,
  usage: message`rm [-r] <path>`,
  brief: message`Remove a file or directory`,
  /**
   * @param {{ path: string, r?: boolean }} parsed
   * @returns {Effect.Effect<void, Error>}
   */
  executeEffect: (parsed) =>
    Effect.gen(function* () {
      const s = yield* fsOp("stat", parsed.path, (fs) => fs.stat(parsed.path));
      if (s.isDirectory) {
        yield* fsOp("rmdir", parsed.path, (fs) =>
          fs.rmdir(parsed.path, { recursive: parsed.r }),
        );
      } else {
        yield* fsOp("unlink", parsed.path, (fs) => fs.unlink(parsed.path));
      }
    }).pipe(
      Effect.asVoid,
      withFsSpan("fs.rm", parsed.path),
    ),
});

export const mvCommand = createCommand({
  name: "mv",
  parser: object({
    source: argument(string({ metavar: "SOURCE" }), {
      description: message`Source file or directory`,
    }),
    dest: argument(string({ metavar: "DEST" }), {
      description: message`Destination file or directory`,
    }),
  }),
  aliases: ["rename", "move"],
  description: message`Move or rename a file`,
  usage: message`mv <source> <dest>`,
  brief: message`Move or rename a file`,
  /**
   * @param {{ source: string, dest: string }} parsed
   * @returns {Effect.Effect<void, Error>}
   */
  executeEffect: (parsed) =>
    fsOp("rename", parsed.source, (fs) => fs.rename(parsed.source, parsed.dest)).pipe(
      Effect.asVoid,
      withFsSpan("fs.mv", `${parsed.source} -> ${parsed.dest}`),
    ),
});

export const statCommand = createCommand({
  name: "stat",
  parser: object({
    path: argument(string({ metavar: "PATH" }), {
      description: message`Path to display information for`,
    }),
  }),
  aliases: ["info"],
  description: message`Display file or directory information`,
  usage: message`stat <path>`,
  brief: message`Display file or directory information`,
  /**
   * @param {{ path: string }} parsed
   * @returns {Effect.Effect<string, Error>}
   */
  executeEffect: (parsed) =>
    fsOp("stat", parsed.path, (fs) => fs.stat(parsed.path)).pipe(
      Effect.map(
        (s) =>
          [
            `  Path: ${parsed.path}`,
            `  Type: ${s.isDirectory ? "directory" : "file"}`,
            `  Size: ${s.size} bytes`,
            `  Modified: ${new Date(s.mtimeMs).toISOString()}`,
          ].join("\n"),
      ),
      withFsSpan("fs.stat", parsed.path),
    ),
});
