import { Plugin } from '../plugin.mjs';

export default class FsPlugin extends Plugin {
  get name() { return 'fs' }
  get commands() { return [
    {
      name: 'ls',
      aliases: ['dir'],
      description: 'List directory contents',
      usage: 'ls [path]',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        const path = args[0] || '.';
        try {
          const entries = await fs.readdir(path);
          const stats = await Promise.all(
            entries.map(async name => {
              const fullPath = path === '.' ? name : `${path}/${name}`;
              try {
                const s = await fs.stat(fullPath);
                return { name, isDirectory: s.isDirectory };
              } catch {
                return { name, isDirectory: false };
              }
            }),
          );
          const lines = stats.map(s => {
            const prefix = s.isDirectory ? '[DIR]' : '[FILE]';
            return `  ${prefix.padEnd(7)} ${s.name}`;
          });
          return lines.join('\n');
        } catch (e) {
          return `ls: ${e.message}`;
        }
      },
    },
    {
      name: 'cd',
      description: 'Change current directory',
      usage: 'cd <path>',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        if (!args[0]) return fs.cwd;
        try {
          const newCwd = await fs.cd(args[0]);
          term.prompt = `${fs.rootName}${newCwd}`;
          return '';
        } catch (e) {
          return `cd: ${e.message}`;
        }
      },
    },
    {
      name: 'pwd',
      description: 'Print working directory',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        return fs.cwd;
      },
    },
    {
      name: 'cat',
      description: 'Display file contents',
      usage: 'cat <file>',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        if (!args[0]) return 'Usage: cat <file>';
        try {
          return await fs.readFile(args[0], { encoding: 'utf8' });
        } catch (e) {
          return `cat: ${e.message}`;
        }
      },
    },
    {
      name: 'mkdir',
      description: 'Create a directory',
      usage: 'mkdir <path>',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        if (!args[0]) return 'Usage: mkdir <path>';
        try {
          await fs.mkdir(args[0], { recursive: true });
          return '';
        } catch (e) {
          return `mkdir: ${e.message}`;
        }
      },
    },
    {
      name: 'rm',
      aliases: ['del', 'delete'],
      description: 'Remove a file or directory',
      usage: 'rm [-r] <path>',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        const recursive = args[0] === '-r';
        const path = recursive ? args[1] : args[0];
        if (!path) return 'Usage: rm [-r] <path>';
        try {
          const s = await fs.stat(path);
          if (s.isDirectory) {
            await fs.rmdir(path, { recursive });
          } else {
            await fs.unlink(path);
          }
          return '';
        } catch (e) {
          return `rm: ${e.message}`;
        }
      },
    },
    {
      name: 'mv',
      aliases: ['rename', 'move'],
      description: 'Move or rename a file',
      usage: 'mv <source> <dest>',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        if (args.length < 2) return 'Usage: mv <source> <dest>';
        try {
          await fs.rename(args[0], args[1]);
          return '';
        } catch (e) {
          return `mv: ${e.message}`;
        }
      },
    },
    {
      name: 'touch',
      description: 'Create an empty file',
      usage: 'touch <path>',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        if (!args[0]) return 'Usage: touch <path>';
        try {
          await fs.writeFile(args[0], '');
          return '';
        } catch (e) {
          return `touch: ${e.message}`;
        }
      },
    },
    {
      name: 'stat',
      aliases: ['info'],
      description: 'Display file or directory information',
      usage: 'stat <path>',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        if (!args[0]) return 'Usage: stat <path>';
        try {
          const s = await fs.stat(args[0]);
          return [
            `  Path: ${args[0]}`,
            `  Type: ${s.isDirectory ? 'directory' : 'file'}`,
            `  Size: ${s.size} bytes`,
            `  Modified: ${new Date(s.mtimeMs).toISOString()}`,
          ].join('\n');
        } catch (e) {
          return `stat: ${e.message}`;
        }
      },
    },
    ];
  }
}
