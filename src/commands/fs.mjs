import { createCommand } from "../terminal.mjs";
import {
  object,
  optional,
  argument,
  string,
  flag,
  message,
} from "@optique/core";

const lsParser = object({
  path: optional(
    argument(string({ metavar: "PATH" }), {
      description: message`Directory path to list`,
    }),
  ),
});

const cdParser = object({
  path: optional(
    argument(string({ metavar: "PATH" }), {
      description: message`Directory path to change to`,
    }),
  ),
});

const pwdParser = object({});

const catParser = object({
  file: argument(string({ metavar: "FILE" }), {
    description: message`File to display`,
  }),
});

const mkdirParser = object({
  path: argument(string({ metavar: "PATH" }), {
    description: message`Directory path to create`,
  }),
});

const rmParser = object({
  r: flag("-r", {
    description: message`Remove directories and their contents recursively`,
  }),
  path: argument(string({ metavar: "PATH" }), {
    description: message`File or directory path to remove`,
  }),
});

const mvParser = object({
  source: argument(string({ metavar: "SOURCE" }), {
    description: message`Source file or directory`,
  }),
  dest: argument(string({ metavar: "DEST" }), {
    description: message`Destination path`,
  }),
});

const touchParser = object({
  path: argument(string({ metavar: "PATH" }), {
    description: message`File path to create`,
  }),
});

const statParser = object({
  path: argument(string({ metavar: "PATH" }), {
    description: message`File or directory path to inspect`,
  }),
});

export const lsCommand = createCommand({
  name: "ls",
  parser: lsParser,
  aliases: ["dir"],
  description: "List directory contents",
  usage: "ls [path]",
  brief: "List directory contents",
  execute: async (parsed, { fs }) => {
    const path = parsed.path || ".";
    try {
      const entries = await fs.readdir(path);
      const stats = await Promise.all(
        entries.map(async (name) => {
          const fullPath = path === "." ? name : `${path}/${name}`;
          try {
            const s = await fs.stat(fullPath);
            return { name, isDirectory: s.isDirectory };
          } catch {
            return { name, isDirectory: false };
          }
        }),
      );
      const lines = stats.map((s) => {
        const prefix = s.isDirectory ? "[DIR]" : "[FILE]";
        return `  ${prefix.padEnd(7)} ${s.name}`;
      });
      return lines.join("\n");
    } catch (e) {
      return `ls: ${e.message}`;
    }
  },
});
export const cdCommand = createCommand({
  name: "cd",
  parser: cdParser,
  description: "Change current directory",
  usage: "cd <path>",
  brief: "Change current directory",
  execute: async (parsed, term) => {
    const { fs } = term;
    if (!parsed.path) return fs.cwd;
    try {
      const newCwd = await fs.cd(parsed.path);
      term.prompt = `${fs.rootName}${newCwd}`;
      return "";
    } catch (e) {
      return `cd: ${e.message}`;
    }
  },
});
export const pwdCommand = createCommand({
  name: "pwd",
  parser: pwdParser,
  description: "Print working directory",
  brief: "Print working directory",
  execute: async (_parsed, { fs }) => fs.cwd,
});
export const catCommand = createCommand({
  name: "cat",
  parser: catParser,
  description: "Display file contents",
  usage: "cat <file>",
  brief: "Display file contents",
  execute: async (parsed, { fs }) => {
    try {
      return await fs.readFile(parsed.file, { encoding: "utf8" });
    } catch (e) {
      return `cat: ${e.message}`;
    }
  },
});

export const mkdirCommand = createCommand({
  name: "mkdir",
  parser: mkdirParser,
  description: "Create a directory",
  usage: "mkdir <path>",
  brief: "Create a directory",
  execute: async (parsed, { fs }) => {
    try {
      await fs.mkdir(parsed.path, { recursive: true });
      return "";
    } catch (e) {
      return `mkdir: ${e.message}`;
    }
  },
});
export const rmCommand = createCommand({
  name: "rm",
  parser: rmParser,
  aliases: ["del", "delete"],
  description: "Remove a file or directory",
  usage: "rm [-r] <path>",
  brief: "Remove a file or directory",
  execute: async (parsed, { fs }) => {
    try {
      const s = await fs.stat(parsed.path);
      if (s.isDirectory) {
        await fs.rmdir(parsed.path, { recursive: parsed.r });
      } else {
        await fs.unlink(parsed.path);
      }
      return "";
    } catch (e) {
      return `rm: ${e.message}`;
    }
  },
});
export const mvCommand = createCommand({
  name: "mv",
  parser: mvParser,
  aliases: ["rename", "move"],
  description: "Move or rename a file",
  usage: "mv <source> <dest>",
  brief: "Move or rename a file",
  execute: async (parsed, { fs }) => {
    try {
      await fs.rename(parsed.source, parsed.dest);
      return "";
    } catch (e) {
      return `mv: ${e.message}`;
    }
  },
});
export const touchCommand = createCommand({
  name: "touch",
  parser: touchParser,
  description: "Create an empty file",
  usage: "touch <path>",
  brief: "Create an empty file",
  execute: async (parsed, { fs }) => {
    try {
      await fs.writeFile(parsed.path, "");
      return "";
    } catch (e) {
      return `touch: ${e.message}`;
    }
  },
});
export const statCommand = createCommand({
  name: "stat",
  parser: statParser,
  aliases: ["info"],
  description: "Display file or directory information",
  usage: "stat <path>",
  brief: "Display file or directory information",
  execute: async (parsed, { fs }) => {
    try {
      const s = await fs.stat(parsed.path);
      return [
        `  Path: ${parsed.path}`,
        `  Type: ${s.isDirectory ? "directory" : "file"}`,
        `  Size: ${s.size} bytes`,
        `  Modified: ${new Date(s.mtimeMs).toISOString()}`,
      ].join("\n");
    } catch (e) {
      return `stat: ${e.message}`;
    }
  },
});
