import { command, or, object, optional, argument, string, option, integer, map, message } from '@optique/core';
import { createCommand } from "../terminal.mjs";

/** @returns {Promise<any>} */
async function getGit() {
  return import('isomorphic-git');
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {any}
 */
function makeGitFs(fs) {
  const methods = ['readFile', 'writeFile', 'unlink', 'readdir', 'mkdir', 'rmdir', 'stat', 'lstat', 'rename'];
  /** @type {any} */
  const wrapped = {};
  for (const m of methods) {
    const orig = /** @type {any} */ (fs)[m];
    /** @type {(...args: any[]) => Promise<any>} */
    const wrapper = async (...args) => {
      try {
        const result = await orig(...args);
        if (m === 'stat' || m === 'lstat') {
          return { ...result, isDirectory: () => result.isDirectory, isFile: () => result.isFile, isSymbolicLink: () => result.isSymbolicLink };
        }
        return result;
      } catch (e) {
        console.log(`gitfs.${m}(${args.map(a => JSON.stringify(a)).join(', ')}) threw:`, e);
        throw e;
      }
    };
    wrapped[m] = wrapper;
  }
  wrapped.readlink = async () => { throw Object.assign(new Error('no such symlink'), { code: 'ENOENT' }); };
  wrapped.symlink = async () => {};
  wrapped.chmod = async () => {};
  wrapped.promises = new Proxy(wrapped, {
    get(target, prop) {
      if (prop === 'readlink') return wrapped.readlink;
      if (prop === 'symlink') return wrapped.symlink;
      if (prop === 'chmod') return wrapped.chmod;
      return target[/** @type {string} */ (prop)];
    },
  });
  return wrapped;
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {Promise<{name: string, email: string}>}
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
  /**
   * @param {{ url: string, method: string, headers: Record<string, string>, body: any }} opts
   * @returns {Promise<{ url: string, method: string, headers: Record<string, string>, body: Uint8Array[], statusCode: number, statusMessage: string }>}
   */
  async request(opts) {
    const { url, method, headers, body } = opts;
    const response = await fetch(url, { method, headers, body });
    const results = await response.arrayBuffer();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const headerEntries = [...response.headers.entries()];
    const plainHeaders = Object.fromEntries(headerEntries);
    return {
      url: response.url,
      method: method,
      headers: plainHeaders,
      body: [new Uint8Array(results)],
      statusCode: response.status,
      statusMessage: response.statusText,
    };
  },
};

/**
 * @param {{ fs: import('../fs.mjs').WebFileSystem }} ctx
 */
const handlerContext = { fs: /** @type {any} */ (null) };

/** @type {Record<string, (parsed: any, ctx: { fs: import('../fs.mjs').WebFileSystem, term?: any }) => Promise<string | undefined>>} */
const handlers = {
  async init(parsed, { fs }) {
    const igit = await getGit();
    const gitFs = makeGitFs(fs);
    await igit.init({ fs: gitFs, dir: fs.cwd });
    return `Initialized empty git repository in ${fs.cwd}/.git`;
  },

  async status(parsed, { fs }) {
    const igit = await getGit();
    const gitFs = makeGitFs(fs);
    const matrix = await igit.statusMatrix({ fs: gitFs, dir: fs.cwd });
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

  async add(parsed, { fs }) {
    const igit = await getGit();
    const gitFs = makeGitFs(fs);
    const filepath = parsed.filepath;
    if (!filepath || filepath === '.') {
      const matrix = await igit.statusMatrix({ fs: gitFs, dir: fs.cwd });
      let count = 0;
      for (const [fp, head, workdir, stage] of matrix) {
        if (workdir !== stage) {
          await igit.add({ fs: gitFs, dir: fs.cwd, filepath: fp });
          count++;
        }
      }
      return `Staged ${count} file(s)`;
    }
    await igit.add({ fs: gitFs, dir: fs.cwd, filepath });
    return `Staged ${filepath}`;
  },

  async commit(parsed, { fs }) {
    const igit = await getGit();
    const msg = parsed.message;
    const gitFs = makeGitFs(fs);
    const author = await getAuthor(fs);
    const sha = await igit.commit({
      fs: gitFs,
      dir: fs.cwd,
      message: msg,
      author,
      committer: author,
    });
    return `[${sha.slice(0, 7)}] ${msg}`;
  },

  async log(parsed, { fs }) {
    const igit = await getGit();
    const gitFs = makeGitFs(fs);
    const depth = parsed.depth || 10;
    const commits = await igit.log({ fs: gitFs, dir: fs.cwd, depth });
    return commits.map(/** @param {any} c */ (c) => {
      const date = new Date(c.commit.author.timestamp * 1000).toLocaleString();
      return `${c.oid.slice(0, 7)} ${date} ${c.commit.author.name}  ${c.commit.message.split('\n')[0]}`;
    }).join('\n');
  },

  async branch(parsed, { fs }) {
    const igit = await getGit();
    const gitFs = makeGitFs(fs);
    const branches = await igit.listBranches({ fs: gitFs, dir: fs.cwd });
    const current = await igit.currentBranch({ fs: gitFs, dir: fs.cwd });
    return branches.map(/** @param {any} b */ (b) => b === current ? `* ${b}` : `  ${b}`).join('\n');
  },

  async checkout(parsed, { fs }) {
    const igit = await getGit();
    const branch = parsed.branch;
    const gitFs = makeGitFs(fs);
    await igit.checkout({ fs: gitFs, dir: fs.cwd, ref: branch });
    return `Switched to branch '${branch}'`;
  },

  async clone(parsed, { fs, term }) {
    const igit = await getGit();
    const url = parsed.url;
    const gitFs = makeGitFs(fs);
    term.log(`Cloning ${url}...`);
    await igit.clone({
      fs: gitFs,
      dir: fs.cwd,
      url,
      http,
      singleBranch: true,
      onProgress: (/** @param {any} ev */ (ev) => {
        if (ev.phase === 'received') return;
        term.log(`${ev.phase}: ${ev.loaded}/${ev.total}`);
      }),
    });
    return `Cloned ${url}`;
  },

  async diff(parsed, { fs }) {
    const igit = await getGit();
    const filepath = parsed.filepath;
    const gitFs = makeGitFs(fs);
    try {
      const matrix = await igit.statusMatrix({ fs: gitFs, dir: fs.cwd });
      const changed = matrix.filter(/** @param {[any, any, any, any]} row */ ([fp, head, workdir, stage]) => {
        if (filepath && fp !== filepath) return false;
        return workdir !== stage;
      });
      if (changed.length === 0) return filepath ? `${filepath}: no changes` : 'no changes';
      return changed.map(/** @param {[any]} row */ ([fp]) => fp).join('\n');
    } catch (/** @type {any} */ e) {
      return `diff failed: ${e.message}`;
    }
  },

  async help(parsed, { fs }) {
    const names = Object.keys(handlers).join(', ');
    return `Usage: git <subcommand> [args]\n\nSubcommands: ${names}`;
  },
};

const subcommandParsers = {
  init: map(object({}), () => ({ subcommand: 'init' })),
  status: map(object({}), () => ({ subcommand: 'status' })),
  add: map(object({
    filepath: optional(argument(string({ metavar: 'FILE' }))),
  }), (r) => ({ subcommand: 'add', ...r })),
  commit: map(object({
    message: option('-m', string({ metavar: 'MESSAGE' })),
  }), (r) => ({ subcommand: 'commit', ...r })),
  log: map(object({
    depth: optional(argument(integer({ metavar: 'DEPTH' }))),
  }), (r) => ({ subcommand: 'log', ...r })),
  branch: map(object({}), () => ({ subcommand: 'branch' })),
  checkout: map(object({
    branch: argument(string({ metavar: 'BRANCH' })),
  }), (r) => ({ subcommand: 'checkout', ...r })),
  clone: map(object({
    url: argument(string({ metavar: 'URL' })),
  }), (r) => ({ subcommand: 'clone', ...r })),
  diff: map(object({
    filepath: optional(argument(string({ metavar: 'FILE' }))),
  }), (r) => ({ subcommand: 'diff', ...r })),
  help: map(object({}), () => ({ subcommand: 'help' })),
};

const gitParser = or(
  command('init', subcommandParsers.init),
  command('status', subcommandParsers.status),
  command('add', subcommandParsers.add),
  command('commit', subcommandParsers.commit),
  command('log', subcommandParsers.log),
  command('branch', subcommandParsers.branch),
  command('checkout', subcommandParsers.checkout),
  command('clone', subcommandParsers.clone),
  command('diff', subcommandParsers.diff),
  command('help', subcommandParsers.help),
);

export default createCommand({
  name: "git",
  aliases: ["g"],
  parser: gitParser,
  description: message`Git version control commands`,
  usage: message`git <subcommand> [args...]`,
  brief: message`Git version control commands`,
  execute: async (parsed, term) => {
    const subcommand = /** @type {string} */ (parsed.subcommand);
    const handler = handlers[/** @type {keyof typeof handlers} */ (subcommand)];
    if (!handler) return `Unknown git subcommand: ${subcommand}. Try 'git help'.`;

    if (subcommand !== 'init' && subcommand !== 'clone') {
      const hasGit = await term.fs.exists('.git');
      if (!hasGit) return "Not a git repository. Run 'git init' first.";
    }

    try {
      const result = await handler(parsed, { fs: term.fs, term });
      if (result != null) return result;
    } catch (/** @type {any} */ e) {
      term.error(`${subcommand}: ${e.message}`);
    }
  },
});
