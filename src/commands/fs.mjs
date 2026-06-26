import { Command, register } from "./index.mjs";

class CdCommand extends Command {
  constructor() {
    super("cd", "Change directory", []);
  }

  async execute(args, { terminal, fs }) {
    const path = args[1] || "/";
    await fs.cd(path);
    terminal.prompt = fs.cwd;
    return "";
  }
}

class LsCommand extends Command {
  constructor() {
    super("ls", "List directory contents", ["dir"]);
  }

  async execute(args, { terminal, fs }) {
    const path = args[1] || ".";
    const entries = await fs.readdir(path);
    if (entries.length === 0) return "(empty)";
    return entries.join("\n");
  }
}

class PwdCommand extends Command {
  constructor() {
    super("pwd", "Print working directory", []);
  }

  async execute(args, { terminal, fs }) {
    return fs.cwd;
  }
}

class MkdirCommand extends Command {
  constructor() {
    super("mkdir", "Make directory", []);
  }

  async execute(args, { terminal, fs }) {
    if (!args[1]) throw new Error("mkdir: missing operand");
    await fs.mkdir(args[1], { recursive: true });
    return "";
  }
}

class RmCommand extends Command {
  constructor() {
    super("rm", "Remove file or directory", ["del"]);
  }

  async execute(args, { terminal, fs }) {
    if (!args[1]) throw new Error("rm: missing operand");
    const recursive = args.includes("-r") || args.includes("-R");
    const targets = args.filter((a) => !a.startsWith("-")).slice(1);
    for (const target of targets) {
      try {
        const stat = await fs.stat(target);
        if (stat.isDirectory) {
          await fs.rmdir(target, { recursive });
        } else {
          await fs.unlink(target);
        }
      } catch (e) {
        if (e.code === "ENOENT") {
          throw new Error(`rm: cannot remove '${target}': No such file or directory`);
        }
        throw e;
      }
    }
    return "";
  }
}

class CatCommand extends Command {
  constructor() {
    super("cat", "Concatenate and print files", ["type"]);
  }

  async execute(args, { terminal, fs }) {
    if (!args[1]) throw new Error("cat: missing file operand");
    const result = [];
    for (let i = 1; i < args.length; i++) {
      const path = args[i];
      const stat = await fs.stat(path);
      if (stat.isDirectory) {
        throw new Error(`cat: ${path}: Is a directory`);
      }
      const content = await fs.readFile(path, { encoding: "utf8" });
      result.push(content);
    }
    return result.join("\n");
  }
}

class TouchCommand extends Command {
  constructor() {
    super("touch", "Create empty file or update timestamp", []);
  }

  async execute(args, { terminal, fs }) {
    if (!args[1]) throw new Error("touch: missing file operand");
    for (let i = 1; i < args.length; i++) {
      const path = args[i];
      try {
        await fs.stat(path);
      } catch (e) {
        if (e.code === "ENOENT") {
          await fs.writeFile(path, "");
        } else {
          throw e;
        }
      }
    }
    return "";
  }
}

class StatCommand extends Command {
  constructor() {
    super("stat", "Display file or file system status", []);
  }

  async execute(args, { terminal, fs }) {
    if (!args[1]) throw new Error("stat: missing file operand");
    const stat = await fs.stat(args[1]);
    const lines = [
      `  Type: ${stat.type}`,
      `  Size: ${stat.size} bytes`,
      `  Modified: ${new Date(stat.mtimeMs).toISOString()}`,
    ];
    return lines.join("\n");
  }
}

class TreeCommand extends Command {
  constructor() {
    super("tree", "List directory contents in a tree", []);
  }

  async execute(args, { terminal, fs }) {
    const path = args[1] || ".";
    const lines = [];

    async function walk(dir, prefix) {
      const entries = await fs.readdir(dir);
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const isLast = i === entries.length - 1;
        const connector = isLast ? "└── " : "├── ";
        lines.push(`${prefix}${connector}${entry}`);

        const entryPath = dir === "." ? entry : `${dir}/${entry}`;
        try {
          const stat = await fs.stat(entryPath);
          if (stat.isDirectory) {
            const nextPrefix = prefix + (isLast ? "    " : "│   ");
            await walk(entryPath, nextPrefix);
          }
        } catch (e) {
          // skip
        }
      }
    }

    lines.push(path);
    await walk(path, "");
    return lines.join("\n");
  }
}

register(new CdCommand());
register(new LsCommand());
register(new PwdCommand());
register(new MkdirCommand());
register(new RmCommand());
register(new CatCommand());
register(new TouchCommand());
register(new StatCommand());
register(new TreeCommand());
