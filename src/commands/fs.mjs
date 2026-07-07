import { createCommand } from "../terminal.mjs";
import { object, optional, argument, string, option, message } from "@optique/core";



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
    r: optional(option("-r", {
        description: message`Remove directories and their contents recursively`,
    })),
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
    description: message`List directory contents`,
    usage: message`ls [path]`,
    brief: message`List directory contents`,
    execute: async (parsed, term) => {
        const path = parsed.path || ".";

        const entries = await term.fs.readdir(path);
        const stats = await Promise.all(
            entries.map(async (name) => {
                const fullPath = path === "." ? name : `${path}/${name}`;
                try {
                    const s = await term.fs.stat(fullPath);
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
        term.log(lines.join("/n"));
    },
});
export const cdCommand = createCommand({
    name: "cd",
    parser: cdParser,
    description: message`Change current directory`,
    usage: message`cd <path>`,
    brief: message`Change current directory`,
    execute: async (parsed, term) => {
        const { fs } = term;
        if (!parsed.path) return fs.cwd;

        const newCwd = await fs.cd(parsed.path);
        term.prompt = `${fs.rootName}${newCwd}`;
    },
});
export const pwdCommand = createCommand({
    name: "pwd",
    parser: pwdParser,
    description: message`Print working directory`,
    brief: message`Print working directory`,
    execute: async (_parsed, term) => term.fs.cwd,
});
export const catCommand = createCommand({
    name: "cat",
    parser: catParser,
    description: message`Display file contents`,
    usage: message`cat <file>`,
    brief: message`Display file contents`,
    execute: async (parsed, { fs }) => {
        return String(await fs.readFile(parsed.file, { encoding: "utf8" }));
    },
});

export const mkdirCommand = createCommand({
    name: "mkdir",
    parser: mkdirParser,
    description: message`Create a directory`,
    usage: message`mkdir <path>`,
    brief: message`Create a directory`,
    execute: async (parsed, { fs }) => {
        await fs.mkdir(parsed.path, { recursive: true });
    },
});
export const rmCommand = createCommand({
    name: "rm",
    parser: rmParser,
    aliases: ["del", "delete"],
    description: message`Remove a file or directory`,
    usage: message`rm [-r] <path>`,
    brief: message`Remove a file or directory`,
    execute: async (parsed, { fs }) => {
        const s = await fs.stat(parsed.path);
        if (s.isDirectory) {
            await fs.rmdir(parsed.path, { recursive: parsed.r });
        } else {
            await fs.unlink(parsed.path);
        }
    },
});
export const mvCommand = createCommand({
    name: "mv",
    parser: mvParser,
    aliases: ["rename", "move"],
    description: message`Move or rename a file`,
    usage: message`mv <source> <dest>`,
    brief: message`Move or rename a file`,
    execute: async (parsed, { fs }) => {
        await fs.rename(parsed.source, parsed.dest);
    },
});

export const statCommand = createCommand({
    name: "stat",
    parser: statParser,
    aliases: ["info"],
    description: message`Display file or directory information`,
    usage: message`stat <path>`,
    brief: message`Display file or directory information`,
    execute: async (parsed, { fs }) => {
        const s = await fs.stat(parsed.path);
        return [
            `  Path: ${parsed.path}`,
            `  Type: ${s.isDirectory ? "directory" : "file"}`,
            `  Size: ${s.size} bytes`,
            `  Modified: ${new Date(s.mtimeMs).toISOString()}`,
        ].join("\n");
    },
});
