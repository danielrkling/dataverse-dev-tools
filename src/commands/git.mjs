import * as git from 'isomorphic-git';
import { Plugin } from '../plugin.mjs';
import { parseArgs } from '../utils/args.mjs';

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 */
function makeGitFs(fs) {
  const shims = {
    readlink: async () => { const e = new Error('no such symlink'); e.code = 'ENOENT'; throw e; },
    symlink: async () => {},
    chmod: async () => {},
  };
  const direct = ['readFile', 'writeFile', 'unlink', 'readdir', 'mkdir', 'rmdir', 'stat', 'lstat', 'rename'];
  const obj = {};
  for (const m of direct) {
    const fn = fs[m].bind(fs);
    obj[m] = async (...args) => {
      try {
        const result = await fn(...args);
        if (m === 'stat' || m === 'lstat') {
          return { ...result, isDirectory: () => result.isDirectory, isFile: () => result.isFile, isSymbolicLink: () => result.isSymbolicLink };
        }
        return result;
      } catch (e) {
        console.log(`gitfs.${m}(${args.map(a => JSON.stringify(a)).join(', ')}) threw:`, e);
        throw e;
      }
    };
  }
  obj.readlink = shims.readlink;
  obj.symlink = shims.symlink;
  obj.chmod = shims.chmod;
  obj.promises = new Proxy(fs.promises, {
    get(target, prop) {
      if (prop === 'readlink') return shims.readlink;
      if (prop === 'symlink') return shims.symlink;
      if (prop === 'chmod') return shims.chmod;
      const fn = target[prop];
      return async (...args) => {
        try {
          const result = await fn(...args);
          if (prop === 'stat' || prop === 'lstat') {
            return { ...result, isDirectory: () => result.isDirectory, isFile: () => result.isFile, isSymbolicLink: () => result.isSymbolicLink };
          }
          return result;
        } catch (e) {
          console.log(`gitfs.promises.${prop}(${args.map(a => JSON.stringify(a)).join(', ')}) threw:`, e);
          throw e;
        }
      };
    },
  });
  return obj;
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 */
async function getAuthor(fs) {
  try {
    const cached = await fs.readFile('.gituser', { encoding: 'utf8' });
    return JSON.parse(cached);
  } catch {}
  try {
    const headers = {
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    };
    const who = await (await fetch('/api/data/v9.2/WhoAmI', { headers })).json();
    const user = await (await fetch(
      `/api/data/v9.2/systemusers(${who.UserId})?$select=fullname,internalemailaddress`,
      { headers },
    )).json();
    const author = { name: user.fullname, email: user.internalemailaddress };
    await fs.writeFile('.gituser', JSON.stringify(author));
    return author;
  } catch {
    return { name: 'Developer', email: 'developer@dataverse.org' };
  }
}

const http = {
  request: async ({ url, method, headers, body }) => {
    const response = await fetch(url, { method, headers, body });
    const results = await response.arrayBuffer();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return {
      url: response.url,
      method: response.method,
      headers: response.headers,
      body: [new Uint8Array(results)],
      statusCode: response.status,
      statusMessage: response.statusText,
    };
  },
};

/** @type {Record<string, (args: string[], term: import('../terminal.mjs').WebTerminal, ctx: { fs: import('../fs.mjs').WebFileSystem }) => Promise<string|undefined>>} */
const subcommands = {
  async init(args, term, { fs }) {
    const gitFs = makeGitFs(fs);
    await git.init({ fs: gitFs, dir: fs.cwd });
    return `Initialized empty git repository in ${fs.cwd}/.git`;
  },

  async status(args, term, { fs }) {
    const gitFs = makeGitFs(fs);
    const matrix = await git.statusMatrix({ fs: gitFs, dir: fs.cwd });
    const lines = [];
    for (const [filepath, head, workdir, stage] of matrix) {
      if (head === 0 && stage === 0) {
        lines.push(`?? ${filepath}`);
        continue;
      }
      const x = stage !== head ? (head === 0 ? 'A' : 'M') : ' ';
      const y = workdir !== stage ? (stage === 0 ? 'A' : 'M') : ' ';
      if (x !== ' ' || y !== ' ') {
        lines.push(`${x}${y} ${filepath}`);
      }
    }
    if (lines.length === 0) return 'nothing to commit, working tree clean';
    return lines.join('\n');
  },

  async add(args, term, { fs }) {
    const gitFs = makeGitFs(fs);
    const filepath = args[0];
    if (!filepath || filepath === '.') {
      const matrix = await git.statusMatrix({ fs: gitFs, dir: fs.cwd });
      let count = 0;
      for (const [fp, head, workdir, stage] of matrix) {
        if (workdir !== stage) {
          await git.add({ fs: gitFs, dir: fs.cwd, filepath: fp });
          count++;
        }
      }
      return `Staged ${count} file(s)`;
    }
    await git.add({ fs: gitFs, dir: fs.cwd, filepath });
    return `Staged ${filepath}`;
  },

  async commit(args, term, { fs }) {
    const { values } = parseArgs(args, { string: ['m'] });
    const message = values.m;
    if (!message) return 'Usage: git commit -m "message"';
    const gitFs = makeGitFs(fs);
    const author = await getAuthor(fs);
    const sha = await git.commit({
      fs: gitFs,
      dir: fs.cwd,
      message,
      author,
      committer: author,
    });
    return `[${sha.slice(0, 7)}] ${message}`;
  },

  async log(args, term, { fs }) {
    const gitFs = makeGitFs(fs);
    const depth = parseInt(args[0]) || 10;
    const commits = await git.log({ fs: gitFs, dir: fs.cwd, depth });
    return commits.map((c) => {
      const date = new Date(c.commit.author.timestamp * 1000).toLocaleString();
      return `${c.oid.slice(0, 7)} ${date} ${c.commit.author.name}  ${c.commit.message.split('\n')[0]}`;
    }).join('\n');
  },

  async branch(args, term, { fs }) {
    const gitFs = makeGitFs(fs);
    const branches = await git.listBranches({ fs: gitFs, dir: fs.cwd });
    const current = await git.currentBranch({ fs: gitFs, dir: fs.cwd });
    return branches.map((b) => b === current ? `* ${b}` : `  ${b}`).join('\n');
  },

  async checkout(args, term, { fs }) {
    const branch = args[0];
    if (!branch) return 'Usage: git checkout <branch>';
    const gitFs = makeGitFs(fs);
    await git.checkout({ fs: gitFs, dir: fs.cwd, ref: branch });
    return `Switched to branch '${branch}'`;
  },

  async clone(args, term, { fs }) {
    const url = args[0];
    if (!url) return 'Usage: git clone <url>';
    const gitFs = makeGitFs(fs);
    term.log(`Cloning ${url}...`);
    await git.clone({
      fs: gitFs,
      dir: fs.cwd,
      url,
      http,
      singleBranch: true,
      onProgress: (ev) => {
        if (ev.phase === 'received') return;
        term.log(`${ev.phase}: ${ev.loaded}/${ev.total}`);
      },
    });
    return `Cloned ${url}`;
  },

  async diff(args, term, { fs }) {
    const gitFs = makeGitFs(fs);
    const filepath = args[0];
    try {
      const diff = await git.diff({
        fs: gitFs,
        dir: fs.cwd,
        ref: 'HEAD',
        ...(filepath ? { filepath } : {}),
      });
      return diff || (filepath ? `${filepath}: no changes` : 'no changes');
    } catch (e) {
      return `diff failed: ${e.message}`;
    }
  },
};

export default class GitPlugin extends Plugin {
  get name() { return 'git' }
  get commands() { return [
    {
      name: 'git',
      aliases: ['g'],
      description: 'Git version control commands',
      usage: 'git <subcommand> [args...]',
      handler: async (args, term, { fs }) => {
        const subcmd = args[0];
        if (!subcmd || subcmd === 'help') {
          const names = Object.keys(subcommands).join(', ');
          return `Usage: git <subcommand> [args]\n\nSubcommands: ${names}`;
        }
        const handler = subcommands[subcmd];
        if (!handler) return `Unknown git subcommand: ${subcmd}. Try 'git help'.`;
        try {
          if (subcmd !== 'init' && subcmd !== 'clone') {
            const hasGit = await fs.exists('.git');
            if (!hasGit) return "Not a git repository. Run 'git init' first.";
          }
          const result = await handler(args.slice(1), term, { fs });
          if (result !== undefined && result !== '') term.log(String(result));
        } catch (e) {
          term.error(`${subcmd}: ${e.message}`);
        }
      },
    },
    ];
  }
}
