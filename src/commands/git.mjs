import { command, or, object, optional, argument, string, option, integer, constant, map, message } from '@optique/core';
import { Effect } from "effect";
import { createCommand } from "../services/commands.mjs";
import { GitStatus, GitStatusLive } from "../services/git-status.mjs";

/**
 * Typed git operation failure (JSDoc-friendly _tag factory — see
 * effects/dataverse-service.mjs). Carries the subcommand so the registry's
 * Cause.pretty output shows a single friendly line.
 * @typedef {{ _tag: "GitError", operation: string, cause: unknown, message: string }} GitError
 */
export const GitError = (/** @type {{ operation: string, cause: unknown }} */ props) => ({
  _tag: /** @type {const} */ ("GitError"),
  message: /** @type {any} */ (props.cause)?.message ?? `git ${props.operation} failed`,
  ...props,
});

/**
 * Build an Error carrying a single friendly line (no stack) — Cause.pretty
 * in the registry then renders exactly one line per command failure.
 * @param {string} message
 * @returns {Error}
 */
const friendlyError = (message) => {
  const err = new Error(message);
  delete err.stack;
  return err;
};

/** @returns {Promise<any>} */
async function getGit() {
  return import('isomorphic-git');
}

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {any}
 */
export function makeGitFs(fs) {
  const methods = ['readFile', 'writeFile', 'unlink', 'readdir', 'mkdir', 'rmdir', 'stat', 'lstat', 'rename'];
  /** @type {any} */
  const wrapped = {};
  for (const m of methods) {
    const orig = /** @type {any} */ (fs)[m];
    /** @type {(...args: any[]) => Promise<any>} */
    const wrapper = async (...args) => {
      try {
        const result = await orig.apply(fs, args);
        if (m === 'stat' || m === 'lstat') {
          return { ...result, isDirectory: () => result.isDirectory, isFile: () => result.isFile, isSymbolicLink: () => result.isSymbolicLink };
        }
        return result;
      } catch (e) {
        throw normalizeFsError(e);
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
 * isomorphic-git expects ENOENT-coded errors to detect missing files/repos,
 * but the File System Access API throws DOMExceptions with different names.
 * @param {any} e
 * @returns {Error}
 */
function normalizeFsError(e) {
  if (!e || typeof e !== 'object') return e;
  if (e.code) return e;
  const name = e.name || '';
  if (name === 'NotFoundError' || name === 'TypeMismatchError') {
    return Object.assign(new Error(`No such file or directory`), { code: 'ENOENT', cause: e });
  }
  return e;
}

/**
 * Computes a two-letter git-style XY status label from a statusMatrix row
 * [filepath, head, workdir, stage]. Values are 0 (absent), 1 (unchanged)
 * and 2/3 (modified / added).
 * @param {[string, number, number, number]} row
 * @returns {string | null} e.g. "M ", " M", "A ", "??", "D " — null when clean
 */
export function statusLabel([, head, workdir, stage]) {
  // Untracked: not in HEAD, present in workdir, not staged.
  if (head === 0 && stage === 0 && workdir !== 0) return '??';

  let x = ' '; // index vs HEAD
  let y = ' '; // workdir vs index

  if (stage !== head) {
    if (head === 0) x = 'A';
    else if (stage === 0) x = 'D';
    else x = 'M';
  }
  if (workdir !== stage) {
    if (stage === 0) y = 'A';
    else if (workdir === 0) y = 'D';
    else y = 'M';
  }
  if (x === ' ' && y === ' ') return null;
  return `${x}${y}`;
}

/**
 * Walks up from the current working directory to find the nearest ancestor
 * containing a `.git` directory. Each top-level directory in the fs usually
 * corresponds to one project, so all per-repo state (author, remotes,
 * credentials) must be scoped to that root rather than the fs root.
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {Promise<string>} absolute path of the repo root (falls back to cwd)
 */
async function findRepoRoot(fs) {
  let dir = fs.cwd;
  while (true) {
    if (await fs.exists(`${dir}/.git`)) return dir;
    if (dir === '/') return fs.cwd;
    dir = ('/' + dir.split('/').filter(Boolean).slice(0, -1).join('/')).replace(/\/+$/, '') || '/';
  }
}

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {Promise<{name: string, email: string}>}
 */
async function getAuthor(fs) {
  const root = await findRepoRoot(fs);
  const userFile = `${root}/.git/user.json`;
  try {
    return JSON.parse(await fs.readFile(userFile, { encoding: 'utf8' }));
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
    await fs.writeFile(userFile, JSON.stringify(author));
    return author;
  } catch {
    return { name: 'Developer', email: 'developer@dataverse.org' };
  }
}

// ---------------------------------------------------------------------------
// Remotes & credentials (repo-scoped, i.e. inside <repoRoot>/.git)
// ---------------------------------------------------------------------------

/** Global bootstrap credential store, used only when no repo exists yet. */
const GLOBAL_CREDS_FILE = '/.gitcreds.json';

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {Promise<Record<string, {url: string}>>}
 */
async function loadRemotes(fs) {
  try {
    const root = await findRepoRoot(fs);
    return JSON.parse(await fs.readFile(`${root}/.git/remotes.json`, { encoding: 'utf8' }));
  } catch {
    return {};
  }
}

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {Record<string, {url: string}>} remotes
 */
async function saveRemotes(fs, remotes) {
  const root = await findRepoRoot(fs);
  await fs.writeFile(`${root}/.git/remotes.json`, JSON.stringify(remotes, null, 2));
}

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {Promise<Record<string, string>>} host -> token
 */
async function loadCreds(fs) {
  // Repo-scoped credentials take precedence over the global bootstrap store.
  try {
    const root = await findRepoRoot(fs);
    return JSON.parse(await fs.readFile(`${root}/.git/creds.json`, { encoding: 'utf8' }));
  } catch {}
  try {
    return JSON.parse(await fs.readFile(GLOBAL_CREDS_FILE, { encoding: 'utf8' }));
  } catch {
    return {};
  }
}

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {Record<string, string>} creds
 */
async function saveCreds(fs, creds) {
  // Inside a repo: store alongside the repo. Outside one (e.g. before the
  // very first clone): use the global store. Writing <cwd>/.git/creds.json
  // unconditionally would fabricate a .git directory and break repo
  // detection, hence the global fallback.
  let target = GLOBAL_CREDS_FILE;
  try {
    const root = await findRepoRoot(fs);
    if (await fs.exists(`${root}/.git`)) target = `${root}/.git/creds.json`;
  } catch {}
  await fs.writeFile(target, JSON.stringify(creds, null, 2));
}

/** @param {string} urlOrHost @returns {string} */
function hostOf(urlOrHost) {
  if (urlOrHost.includes('://')) {
    try {
      return new URL(urlOrHost).host;
    } catch {
      return urlOrHost;
    }
  }
  return urlOrHost;
}

/**
 * Builds an onAuth callback that resolves tokens from the stored credential
 * store by host. Works with GitLab PATs (username "oauth2") and GitHub PATs
 * (username as anything, password = token).
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {string[]} urls candidate remote URLs, most specific first
 * @returns {Promise<(url: string) => { username: string, password: string } | undefined>}
 */
async function makeOnAuth(fs, urls = []) {
  const creds = await loadCreds(fs);
  return (url) => {
    const candidates = [url, ...urls].map(hostOf);
    for (const host of candidates) {
      const token = creds[host];
      if (token) return { username: 'oauth2', password: token };
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// CORS proxies (repo-scoped inside <repoRoot>/.git, global fallback before
// the first clone — same layout as the credential store)
// ---------------------------------------------------------------------------

/** Global bootstrap proxy store, used only when no repo exists yet. */
const GLOBAL_PROXIES_FILE = '/.gitproxies.json';

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {Promise<Record<string, string>>} host -> proxy URL template
 */
async function loadProxies(fs) {
  try {
    const root = await findRepoRoot(fs);
    return JSON.parse(await fs.readFile(`${root}/.git/proxies.json`, { encoding: 'utf8' }));
  } catch {}
  try {
    return JSON.parse(await fs.readFile(GLOBAL_PROXIES_FILE, { encoding: 'utf8' }));
  } catch {
    return {};
  }
}

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {Record<string, string>} proxies
 */
async function saveProxies(fs, proxies) {
  // Same rule as saveCreds: never fabricate a .git directory outside a repo
  // (it would break findRepoRoot), so fall back to the global store.
  let target = GLOBAL_PROXIES_FILE;
  try {
    const root = await findRepoRoot(fs);
    if (await fs.exists(`${root}/.git`)) target = `${root}/.git/proxies.json`;
  } catch {}
  await fs.writeFile(target, JSON.stringify(proxies, null, 2));
}

/**
 * Routes a git smart-HTTP URL through the per-host CORS proxy, if one is
 * configured. Templates: a proxy containing "{url}" gets the (encoded) URL
 * substituted; otherwise the URL is appended to the proxy origin
 * (e.g. "https://cors.isomorphic-git.org" + "/" + original URL).
 * @param {string} url
 * @param {Record<string, string>} proxies
 * @returns {string}
 */
function applyProxy(url, proxies) {
  try {
    const proxy = proxies[new URL(url).host];
    if (!proxy) return url;
    if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(url));
    return `${proxy.replace(/\/+$/, '')}/${url}`;
  } catch {
    return url;
  }
}

/**
 * Builds the isomorphic-git http layer, routing requests through any
 * per-host CORS proxy the user configured (`git proxy set <host> <url>`).
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 */
async function makeHttp(fs) {
  const proxies = await loadProxies(fs);
  return {
    /**
     * Unlike a naive fetch wrapper this must NOT throw on non-2xx:
     * isomorphic-git inspects statusCode itself (401 -> auth flow, 404 -> repo
     * not found, etc.) and throwing here breaks those flows.
     * @param {{ url: string, method: string, headers: Record<string, string>, body: any }} opts
     * @returns {Promise<{ url: string, method: string, headers: Record<string, string>, body: Uint8Array[], statusCode: number, statusMessage: string }>}
     */
    async request(opts) {
      const { url, method, headers, body } = opts;
      const response = await fetch(applyProxy(url, proxies), { method, headers, body });
      const buffer = await response.arrayBuffer();
      return {
        url: response.url,
        method,
        headers: Object.fromEntries(response.headers.entries()),
        body: [new Uint8Array(buffer)],
        statusCode: response.status,
        statusMessage: response.statusText,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

/**
 * Simple LCS-based line diff producing unified-diff-style hunks.
 * Falls back to a summary when files are very large (DP would be O(n*m)).
 * @param {string} oldText
 * @param {string} newText
 * @param {number} context
 * @returns {string[]}
 */
export function lineDiff(oldText, newText, context = 3) {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];

  if (a.length * b.length > 4_000_000) {
    return [`(file too large to diff: ${a.length} -> ${b.length} lines)`];
  }

  // LCS table
  const n = a.length, m = b.length;
  /** @type {Uint16Array[]} */
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk to produce edit script
  /** @type {{ t: 'same' | '+' | '-', line: string }[]} */
  const edits = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { edits.push({ t: 'same', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { edits.push({ t: '-', line: a[i] }); i++; }
    else { edits.push({ t: '+', line: b[j] }); j++; }
  }
  while (i < n) { edits.push({ t: '-', line: a[i] }); i++; }
  while (j < m) { edits.push({ t: '+', line: b[j] }); j++; }

  if (!edits.some((e) => e.t !== 'same')) return [];

  // Group into hunks with `context` lines around changes
  /** @type {string[]} */
  const out = [];
  let k = 0;
  while (k < edits.length) {
    if (edits[k].t === 'same') { k++; continue; }
    let start = Math.max(0, k - context);
    let end = k;
    while (end < edits.length) {
      if (edits[end].t !== 'same') { end++; continue; }
      // extend through runs of <= 2*context unchanged lines followed by another change
      let run = end;
      while (run < edits.length && edits[run].t === 'same') run++;
      if (run - end > context * 2 || run === edits.length) break;
      end = run;
    }
    end = Math.min(edits.length, end + context);

    let oldStart = start + 1, newStart = start + 1;
    for (let x = 0; x < start; x++) {
      if (edits[x].t !== '+') oldStart++;
      if (edits[x].t !== '-') newStart++;
    }
    let oldLines = 0, newLines = 0;
    for (let x = start; x < end; x++) {
      if (edits[x].t !== '+') oldLines++;
      if (edits[x].t !== '-') newLines++;
    }
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    for (let x = start; x < end; x++) {
      const e = edits[x];
      if (e.t === 'same') out.push(` ${e.line}`);
      else out.push(`${e.t}${e.line}`);
    }
    k = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitLab API-synced project detection
// ---------------------------------------------------------------------------

const GITLAB_MANIFEST = '.git/gitlab.json';

/**
 * Detects a project cloned via 'gitlab clone' (manifest written by the
 * gitlab command). Those repos keep a real local .git (so status, diff,
 * commit, restore and the tree badges all work with isomorphic-git), but
 * push/pull must go through the CORS-safe GitLab REST API.
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {Promise<any | null>}
 */
async function readGitlabManifest(fs) {
  try {
    return JSON.parse(await fs.readFile(`${fs.cwd}/${GITLAB_MANIFEST}`, { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {Promise<{ git: any, gitFs: any }>}
 */
async function gitCtx(fs) {
  const igit = await getGit();
  return { git: igit, gitFs: makeGitFs(fs) };
}

/**
 * Returns the resolved remote URL for push/fetch operations.
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {string | undefined} name
 */
async function resolveRemote(fs, name) {
  const remotes = await loadRemotes(fs);
  if (name && !remotes[name]) throw new Error(`remote '${name}' not found`);
  const key = name || Object.keys(remotes)[0];
  if (!key) throw new Error("no remote configured. Use 'git remote add <name> <url>'.");
  return { name: key, ...remotes[key] };
}

/**
 * Directories never walked by status/diff/add/commit scans. Used as the
 * default ignore set when the repo has no .gitignore; names parsed from a
 * .gitignore are merged on top.
 */
const DEFAULT_IGNORED_DIRS = ['node_modules', '.git'];

/**
 * Top-level directory names to skip during workdir scans: the defaults plus
 * any plain (non-glob, non-negated) names from <cwd>/.gitignore.
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {Promise<Set<string>>}
 */
async function ignoredTopDirs(fs) {
    const ignored = new Set(DEFAULT_IGNORED_DIRS);
    try {
        const raw = await fs.readFile(`${fs.cwd}/.gitignore`, { encoding: 'utf8' });
        for (let line of String(raw).split('\n')) {
            line = line.trim();
            if (!line || line.startsWith('#') || line.startsWith('!')) continue;
            const name = line.replace(/\/+$/, '').split('/').pop() ?? '';
            if (name && !name.includes('*')) ignored.add(name);
        }
    } catch { /* no .gitignore — defaults only */ }
    return ignored;
}

/**
 * statusMatrix with ignored directories (node_modules et al.) filtered out of
 * the walk. isomorphic-git's statusMatrix does NOT apply .gitignore, so it
 * would otherwise traverse — and offer to stage — everything under the repo.
 * We scan only top-level entries (dirs minus the ignore set, plus top files);
 * un-ignored directories are recursed by statusMatrix itself.
 * @param {any} git isomorphic-git module
 * @param {any} gitFs wrapped fs (makeGitFs)
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @returns {Promise<[string, number, number, number][]>}
 */
export async function workdirMatrix(git, gitFs, fs) {
    const ignored = await ignoredTopDirs(fs);
    /** @type {string[] | undefined} */
    let filepaths;
    try {
        const tops = await fs.readdir(fs.cwd, { types: true });
        filepaths = tops
            .filter(([name, kind]) => kind === 'file' || !ignored.has(name))
            .map(([name]) => name);
    } catch { /* fall back to a full walk */ }
    if (!filepaths || filepaths.length === 0) filepaths = ['.'];
    return git.statusMatrix({ fs: gitFs, dir: fs.cwd, filepaths });
}

/** @type {Record<string, (parsed: any, ctx: { fs: import('../services/fs.mjs').WebFileSystem, term?: any }) => Promise<string | undefined>>} */
const handlers = {  async init(parsed, { fs }) {
    const { git, gitFs } = await gitCtx(fs);
    await git.init({ fs: gitFs, dir: fs.cwd });
    // Seed a .gitignore (node_modules et al. — matches workdirMatrix's
    // default ignore set) unless the user already has one.
    let created = false;
    if (!(await fs.exists(`${fs.cwd}/.gitignore`))) {
      const defaultIgnore = [
        '# Dependencies',
        'node_modules/',
        '',
        '# Build output',
        'dist/',
        'build/',
        'out/',
        '',
        '# Logs & OS',
        '*.log',
        '.DS_Store',
        '',
      ].join('\n');
      await fs.writeFile(`${fs.cwd}/.gitignore`, defaultIgnore, { encoding: 'utf8' });
      created = true;
    }
    return `Initialized empty git repository in ${fs.cwd}/.git${created ? ' (created .gitignore)' : ''}`;
  },

  async status(parsed, { fs }) {
    const { git, gitFs } = await gitCtx(fs);
    const branch = await git.currentBranch({ fs: gitFs, dir: fs.cwd });
    const matrix = await workdirMatrix(git, gitFs, fs);
    const lines = [];
    for (const row of matrix) {
      const label = statusLabel(row);
      if (label) lines.push(`${label} ${row[0]}`);
    }
    const header = branch ? `On branch ${branch}` : 'HEAD detached';
    if (lines.length === 0) return `${header}\nnothing to commit, working tree clean`;
    return `${header}\n\nChanges:\n${lines.join('\n')}`;
  },

  async add(parsed, { fs }) {
    const { git, gitFs } = await gitCtx(fs);
    const filepath = parsed.filepath;

    if (!filepath || filepath === '.') {
      const matrix = await workdirMatrix(git, gitFs, fs);
      let added = 0, removed = 0;
      for (const [fp, head, workdir, stage] of matrix) {
        if (workdir === 0 && stage !== 0) {
          // File deleted in the workdir: stage the deletion.
          await git.remove({ fs: gitFs, dir: fs.cwd, filepath: fp });
          removed++;
        } else if (workdir !== 0 && workdir !== stage) {
          await git.add({ fs: gitFs, dir: fs.cwd, filepath: fp });
          added++;
        }
      }
      const parts = [];
      if (added) parts.push(`${added} file(s) added`);
      if (removed) parts.push(`${removed} deletion(s) staged`);
      return parts.length ? `Staged ${parts.join(', ')}` : 'Nothing to stage';
    }

    await git.add({ fs: gitFs, dir: fs.cwd, filepath });
    return `Staged ${filepath}`;
  },

  async rm(parsed, { fs }) {
    const { git, gitFs } = await gitCtx(fs);
    await git.remove({ fs: gitFs, dir: fs.cwd, filepath: parsed.filepath });
    await fs.unlink(parsed.filepath);
    return `rm '${parsed.filepath}'`;
  },

  async mv(parsed, { fs }) {
    const { git, gitFs } = await gitCtx(fs);
    const { source, target } = parsed;
    await fs.rename(source, target);
    await git.add({ fs: gitFs, dir: fs.cwd, filepath: target });
    await git.remove({ fs: gitFs, dir: fs.cwd, filepath: source });
    return `Renamed ${source} -> ${target}`;
  },

  async commit(parsed, { fs }) {
    const { git, gitFs } = await gitCtx(fs);
    if (parsed.all) {
      // Stage everything (including deletions) before committing.
      const matrix = await workdirMatrix(git, gitFs, fs);
      for (const [fp, head, workdir, stage] of matrix) {
        if (workdir === 0 && stage !== 0) await git.remove({ fs: gitFs, dir: fs.cwd, filepath: fp });
        else if (workdir !== 0 && workdir !== stage) await git.add({ fs: gitFs, dir: fs.cwd, filepath: fp });
      }
    }
    const author = await getAuthor(fs);
    const sha = await git.commit({
      fs: gitFs,
      dir: fs.cwd,
      message: parsed.message,
      author,
      committer: author,
      amend: parsed.amend || false,
      noUpdateBranch: false,
    });
    return `[${sha.slice(0, 7)}]${parsed.amend ? ' (amended)' : ''} ${parsed.message}`;
  },

  async log(parsed, { fs }) {
    const { git, gitFs } = await gitCtx(fs);
    const depth = parsed.depth || 10;
    const commits = await git.log({ fs: gitFs, dir: fs.cwd, depth });
    if (commits.length === 0) return 'no commits yet';
    return commits.map(/** @param {any} c */ (c) => {
      const date = new Date(c.commit.author.timestamp * 1000).toLocaleString();
      return `${c.oid.slice(0, 7)} ${date} ${c.commit.author.name}  ${c.commit.message.split('\n')[0]}`;
    }).join('\n');
  },

  async branch(parsed, { fs }) {
    const { git, gitFs } = await gitCtx(fs);
    if (parsed.delete) {
      await git.deleteBranch({ fs: gitFs, dir: fs.cwd, ref: parsed.name });
      return `Deleted branch ${parsed.name}`;
    }
    if (parsed.name) {
      await git.branch({ fs: gitFs, dir: fs.cwd, ref: parsed.name });
      return `Created branch ${parsed.name}`;
    }
    const branches = await git.listBranches({ fs: gitFs, dir: fs.cwd });
    const current = await git.currentBranch({ fs: gitFs, dir: fs.cwd });
    return branches.map(/** @param {any} b */ (b) => b === current ? `* ${b}` : `  ${b}`).join('\n');
  },

  async checkout(parsed, { fs }) {
    const { git, gitFs } = await gitCtx(fs);
    if (parsed.create) {
      await git.branch({ fs: gitFs, dir: fs.cwd, ref: parsed.ref });
    }
    await git.checkout({ fs: gitFs, dir: fs.cwd, ref: parsed.ref });
    return `Switched to branch '${parsed.ref}'${parsed.create ? ' (new)' : ''}`;
  },

  async clone(parsed, { fs, term }) {
    const { git, gitFs } = await gitCtx(fs);
    const http = await makeHttp(fs);
    const url = parsed.url;
    // Clone into a subdirectory named after the repo unless one was given.
    let dir = parsed.dir;
    if (!dir) {
      const base = url.split('/').pop() || 'repo';
      dir = base.replace(/\.git$/, '');
    }
    const onAuth = await makeOnAuth(fs, [url]);
    term.log(`Cloning ${url} into ${dir}/...`);
    try {
      await git.clone({
        fs: gitFs,
        dir: `${fs.cwd}/${dir}`.replace(/\/+/g, '/'),
        url,
        http,
        onAuth,
        singleBranch: !!parsed.depth,
        depth: parsed.depth,
        ref: parsed.branch,
        onProgress: (/** @param {any} ev */ (ev) => {
          if (ev.phase === 'received') return;
          term.log(`${ev.phase}: ${ev.loaded}/${ev.total}`);
        }),
      });
    } catch (/** @type {any} */ e) {
      // Browser fetch failures here are almost always CORS: the git
      // endpoints of github.com (and some self-hosted GitLabs) don't send
      // Access-Control-Allow-Origin.
      if (/Failed to fetch|NetworkError|CORS|Load failed/i.test(e?.message ?? '') || e instanceof TypeError) {
        return [
          `Direct git access to ${url} failed (the browser blocked it — CORS).`,
          'Options:',
          '  git proxy set <host> <proxy-url>   # route this host through a CORS proxy',
          '  gitlab clone <group/project>       # GitLab: REST-based clone, no proxy needed',
        ].join('\n');
      }
      throw e;
    }
    // Remember origin so push/pull work right away.
    const repoRoot = `${fs.cwd}/${dir}`.replace(/\/+/g, '/');
    await fs.writeFile(`${repoRoot}/.git/remotes.json`, JSON.stringify({ origin: { url } }, null, 2));
    return `Cloned ${url} into ${dir}/`;
  },

  async fetch(parsed, { fs, term }) {
    const { git, gitFs } = await gitCtx(fs);
    const http = await makeHttp(fs);
    const remote = await resolveRemote(fs, parsed.remote);
    const onAuth = await makeOnAuth(fs, [remote.url]);
    term.log(`Fetching ${remote.name} (${remote.url})...`);
    await git.fetch({
      fs: gitFs,
      dir: fs.cwd,
      url: remote.url,
      http,
      onAuth,
      depth: parsed.depth,
    });
    return `Fetched ${remote.name}`;
  },

  async pull(parsed, { fs, term }) {
    // GitLab API-synced project: pull through the REST API (compare endpoint).
    if (await readGitlabManifest(fs)) {
      const gitlab = await import('./gitlab.mjs');
      return gitlab.apiPull(fs, term, { force: parsed.force });
    }
    const { git, gitFs } = await gitCtx(fs);
    const http = await makeHttp(fs);
    const remote = await resolveRemote(fs, parsed.remote);
    const onAuth = await makeOnAuth(fs, [remote.url]);
    const branch = parsed.branch || await git.currentBranch({ fs: gitFs, dir: fs.cwd, fullname: true });
    if (!branch) return 'Not on any branch.';
    term.log(`Pulling ${remote.name}/${branch.split('/').pop()}...`);
    await git.fastForwardBranch({
      fs: gitFs,
      dir: fs.cwd,
      ref: branch,
      url: remote.url,
      http,
      onAuth,
    });
    return `Already up to date (fast-forwarded ${branch})`;
  },

  async push(parsed, { fs, term }) {
    // GitLab API-synced project: push through the REST commits API.
    if (await readGitlabManifest(fs)) {
      const gitlab = await import('./gitlab.mjs');
      return gitlab.apiPush(fs, term, {
        message: parsed.message || 'Update from dataverse-webresource-ide',
        branch: parsed.branch,
        force: parsed.force,
      });
    }
    const { git, gitFs } = await gitCtx(fs);
    const http = await makeHttp(fs);
    const remote = await resolveRemote(fs, parsed.remote);
    const onAuth = await makeOnAuth(fs, [remote.url]);
    const branchRef = await git.currentBranch({ fs: gitFs, dir: fs.cwd, fullname: true });
    if (!branchRef) return 'Not on any branch.';
    const short = branchRef.split('/').pop();
    term.log(`Pushing ${short} to ${remote.name}...`);
    const result = await git.push({
      fs: gitFs,
      dir: fs.cwd,
      url: remote.url,
      http,
      onAuth,
      remoteRef: parsed.branch || short,
      onProgress: (/** @param {any} ev */ (ev) => {
        if (ev.phase === 'received') return;
        term.log(`${ev.phase}: ${ev.loaded}/${ev.total}`);
      }),
    });
    if (result.ok) {
      return result.data?.alreadyUpToDate
        ? 'Everything up-to-date'
        : `Pushed ${short} -> ${remote.name}/${parsed.branch || short}`;
    }
    return `push failed: ${result.error?.message ?? 'unknown error'}`;
  },

  async remote(parsed, { fs }) {
    const remotes = await loadRemotes(fs);
    if (parsed.remoteAction === 'add') {
      if (remotes[parsed.name]) throw new Error(`remote '${parsed.name}' already exists`);
      remotes[parsed.name] = { url: parsed.url };
      await saveRemotes(fs, remotes);
      return `Added remote '${parsed.name}' -> ${parsed.url}`;
    }
    if (parsed.remoteAction === 'remove') {
      if (!remotes[parsed.name]) throw new Error(`remote '${parsed.name}' not found`);
      delete remotes[parsed.name];
      await saveRemotes(fs, remotes);
      return `Removed remote '${parsed.name}'`;
    }
    const entries = Object.entries(remotes);
    if (entries.length === 0) return 'no remotes configured';
    return entries.map(([name, r]) => `${name}\t${r.url}`).join('\n');
  },

  async reset(parsed, { fs }) {
    const { git, gitFs } = await gitCtx(fs);
    const filepath = parsed.filepath;
    if (filepath && filepath !== '.') {
      await git.resetIndex({ fs: gitFs, dir: fs.cwd, filepath });
      return `Unstaged ${filepath}`;
    }
    const matrix = await workdirMatrix(git, gitFs, fs);
    let count = 0;
    for (const [fp, head, , stage] of matrix) {
      if (stage !== head) {
        await git.resetIndex({ fs: gitFs, dir: fs.cwd, filepath: fp });
        count++;
      }
    }
    return count ? `Unstaged ${count} file(s)` : 'Index matches HEAD';
  },

  async creds(parsed, { fs }) {
    const creds = await loadCreds(fs);
    if (parsed.credsAction === 'set') {
      const host = hostOf(parsed.host);
      creds[host] = parsed.token;
      await saveCreds(fs, creds);
      return `Stored credential for ${host}`;
    }
    if (parsed.credsAction === 'remove') {
      const host = hostOf(parsed.host);
      if (!creds[host]) return `No credential stored for ${host}`;
      delete creds[host];
      await saveCreds(fs, creds);
      return `Removed credential for ${host}`;
    }
    const hosts = Object.keys(creds);
    return hosts.length ? `Credentials stored for:\n${hosts.join('\n')}` : 'No credentials stored';
  },

  async diff(parsed, { fs }) {
    const { git, gitFs } = await gitCtx(fs);
    const oid = await git.resolveRef({ fs: gitFs, dir: fs.cwd, ref: 'HEAD' }).catch(() => null);
    const matrix = await workdirMatrix(git, gitFs, fs);
    const changed = matrix.filter((/** @type {[string, number, number, number]} */ row) => {
      const label = statusLabel(row);
      if (!label) return false;
      if (parsed.filepath && row[0] !== parsed.filepath) return false;
      if (label === '??' && !parsed.includeUntracked) return false;
      return true;
    });

    if (changed.length === 0) {
      return parsed.filepath ? `${parsed.filepath}: no changes` : 'no changes';
    }

    /** @type {string[]} */
    const output = [];
    for (const [fp, head] of changed) {
      /** @type {string} */
      let oldText = '';
      if (head !== 0 && oid) {
        try {
          const blob = await git.readBlob({ fs: gitFs, dir: fs.cwd, oid, filepath: fp });
          oldText = new TextDecoder().decode(blob.blob);
        } catch {}
      }
      let newText = '';
      try {
        newText = await fs.readFile(fp, { encoding: 'utf8' });
      } catch {}
      output.push(`--- a/${fp}`);
      output.push(`+++ b/${fp}`);
      const hunks = lineDiff(oldText, newText);
      output.push(...(hunks.length ? hunks : ['(binary or identical content)']));
    }
    return output.join('\n');
  },

  // `git restore` is handled by executeEffect via the shared GitStatus
  // service (services/git-status.mjs discardFileChanges) — the checkout
  // logic lives there now and is not duplicated here.

  async proxy(parsed, { fs }) {
    const proxies = await loadProxies(fs);
    if (parsed.proxyAction === 'set') {
      const host = hostOf(parsed.host);
      proxies[host] = parsed.url;
      await saveProxies(fs, proxies);
      return `Proxy for ${host} -> ${parsed.url}`;
    }
    if (parsed.proxyAction === 'remove') {
      const host = hostOf(parsed.host);
      if (!proxies[host]) return `No proxy stored for ${host}`;
      delete proxies[host];
      await saveProxies(fs, proxies);
      return `Removed proxy for ${host}`;
    }
    const entries = Object.entries(proxies);
    if (entries.length === 0) {
      return [
        'no proxies configured. Example:',
        '  git proxy set github.com https://cors.isomorphic-git.org',
        '  git proxy set git.example.com https://my-proxy.example.com/{url}',
      ].join('\n');
    }
    return entries.map(([host, url]) => `${host}\t${url}`).join('\n');
  },

  async help(parsed, { fs }) {
    const names = [...Object.keys(handlers), 'restore'].filter((k) => k !== 'help').join(', ');
    return [
      'Usage: git <subcommand> [args]',
      '',
      `Subcommands: ${names}`,
      '',
      'Examples:',
      '  git init                                  # init repo in cwd',
      '  git add .                                 # stage all (incl. deletions)',
      '  git commit -m "msg"                       # commit staged',
      '  git commit -a -m "msg"                    # stage all + commit',
      '  git remote add origin https://gitlab.com/group/repo.git',
      '  git creds set gitlab.com <PAT>            # store a token for private repos (per-repo once inside one, global before first clone)',
      '  git proxy set github.com https://cors.isomorphic-git.org',
      '  git proxy set host https://my-proxy/{url}  # route git HTTP for <host> through a CORS proxy',
      '  git proxy remove <host>                    # stop proxying a host',
      '  git proxy                                  # list configured proxies',
      '  git push                                  # push current branch to origin',
      '  git pull                                  # fast-forward from origin',
      '  git diff                                  # unified diff of changes',
      '  git restore <file>                        # discard workdir changes to a file',
    ].join('\n');
  },
};

const subcommandParsers = {
  init: map(object({}), () => ({ subcommand: 'init' })),
  status: map(object({}), () => ({ subcommand: 'status' })),
  add: map(object({
    filepath: optional(argument(string({ metavar: 'FILE' }))),
  }), (r) => ({ subcommand: 'add', ...r })),
  rm: map(object({
    filepath: argument(string({ metavar: 'FILE' })),
  }), (r) => ({ subcommand: 'rm', ...r })),
  mv: map(object({
    source: argument(string({ metavar: 'SOURCE' })),
    target: argument(string({ metavar: 'TARGET' })),
  }), (r) => ({ subcommand: 'mv', ...r })),
  commit: map(object({
    message: option('-m', '--message', string({ metavar: 'MESSAGE' })),
    all: option('-a', '--all'),
    amend: option('--amend'),
  }), (r) => ({ subcommand: 'commit', ...r })),
  log: map(object({
    depth: optional(argument(integer({ metavar: 'DEPTH' }))),
  }), (r) => ({ subcommand: 'log', ...r })),
  branch: map(object({
    name: optional(argument(string({ metavar: 'NAME' }))),
    delete: option('-d', '--delete'),
  }), (r) => ({ subcommand: 'branch', ...r })),
  checkout: map(object({
    ref: argument(string({ metavar: 'BRANCH' })),
    create: option('-b', '--create'),
  }), (r) => ({ subcommand: 'checkout', ...r })),
  clone: map(object({
    url: argument(string({ metavar: 'URL' })),
    dir: optional(argument(string({ metavar: 'DIR' }))),
    depth: optional(option('--depth', integer({ metavar: 'N' }))),
    branch: optional(option('-b', '--branch', string({ metavar: 'BRANCH' }))),
  }), (r) => ({ subcommand: 'clone', ...r })),
  fetch: map(object({
    remote: optional(argument(string({ metavar: 'REMOTE' }))),
    depth: optional(option('--depth', integer({ metavar: 'N' }))),
  }), (r) => ({ subcommand: 'fetch', ...r })),
  pull: map(object({
    remote: optional(argument(string({ metavar: 'REMOTE' }))),
    branch: optional(argument(string({ metavar: 'BRANCH' }))),
  }), (r) => ({ subcommand: 'pull', ...r })),
  push: map(object({
    remote: optional(argument(string({ metavar: 'REMOTE' }))),
    branch: optional(argument(string({ metavar: 'BRANCH' }))),
  }), (r) => ({ subcommand: 'push', ...r })),
  remote: map(or(
    map(object({
      remoteAction: constant('add'),
      name: argument(string({ metavar: 'NAME' })),
      url: argument(string({ metavar: 'URL' })),
    }), (r) => ({ subcommand: 'remote', ...r })),
    map(object({
      remoteAction: constant('remove'),
      name: argument(string({ metavar: 'NAME' })),
    }), (r) => ({ subcommand: 'remote', ...r })),
    map(object({
      remoteAction: constant('list'),
    }), (r) => ({ subcommand: 'remote', ...r })),
  ), (r) => r),
  reset: map(object({
    filepath: optional(argument(string({ metavar: 'FILE' }))),
  }), (r) => ({ subcommand: 'reset', ...r })),
  creds: map(or(
    map(object({
      credsAction: constant('set'),
      host: argument(string({ metavar: 'HOST' })),
      token: argument(string({ metavar: 'TOKEN' })),
    }), (r) => ({ subcommand: 'creds', ...r })),
    map(object({
      credsAction: constant('remove'),
      host: argument(string({ metavar: 'HOST' })),
    }), (r) => ({ subcommand: 'creds', ...r })),
    map(object({
      credsAction: constant('list'),
    }), (r) => ({ subcommand: 'creds', ...r })),
  ), (r) => r),
  proxy: map(or(
    map(object({
      proxyAction: constant('set'),
      host: argument(string({ metavar: 'HOST' })),
      url: argument(string({ metavar: 'URL' })),
    }), (r) => ({ subcommand: 'proxy', ...r })),
    map(object({
      proxyAction: constant('remove'),
      host: argument(string({ metavar: 'HOST' })),
    }), (r) => ({ subcommand: 'proxy', ...r })),
    map(object({
      proxyAction: constant('list'),
    }), (r) => ({ subcommand: 'proxy', ...r })),
  ), (r) => r),
  diff: map(object({
    filepath: optional(argument(string({ metavar: 'FILE' }))),
    includeUntracked: optional(option('--include-untracked')),
  }), (r) => ({ subcommand: 'diff', ...r })),
  restore: map(object({
    filepath: argument(string({ metavar: 'FILE' })),
  }), (r) => ({ subcommand: 'restore', ...r })),
  help: map(object({}), () => ({ subcommand: 'help' })),
};

const gitParser = or(
  or(
    command('init', subcommandParsers.init),
    command('status', subcommandParsers.status),
    command('add', subcommandParsers.add),
    command('rm', subcommandParsers.rm),
    command('mv', subcommandParsers.mv),
    command('commit', subcommandParsers.commit),
    command('log', subcommandParsers.log),
    command('branch', subcommandParsers.branch),
    command('checkout', subcommandParsers.checkout),
  ),
  or(
    command('clone', subcommandParsers.clone),
    command('fetch', subcommandParsers.fetch),
    command('pull', subcommandParsers.pull),
    command('push', subcommandParsers.push),
    command('remote', subcommandParsers.remote),
    command('reset', subcommandParsers.reset),
    command('creds', subcommandParsers.creds),
    command('proxy', subcommandParsers.proxy),
    command('diff', subcommandParsers.diff),
    command('restore', subcommandParsers.restore),
    command('help', subcommandParsers.help),
  ),
);

export default createCommand({
  name: "git",
  aliases: ["g"],
  parser: gitParser,
  description: message`Git version control commands`,
  usage: message`git <subcommand> [args...]`,
  brief: message`Git version control commands`,
  /**
   * Effect-based execution: one span per subcommand (`git.<op>`), typed
   * GitError mapped to a single friendly Error for the registry, and
   * `git restore` routed through the shared GitStatus service.
   *
   * @param {any} parsed
   * @param {import("../types/terminal.d.ts").Terminal} term
   * @returns {Effect.Effect<string | undefined, Error>}
   */
  timeoutSeconds: 600, // statusMatrix walks every file — slow over FS Access API
  executeEffect: (parsed, term) => {
    const subcommand = /** @type {string} */ (parsed.subcommand);
    const span = `git.${subcommand}`;
    return /** @type {Effect.Effect<string | undefined, Error>} */ (
      Effect.gen(function* () {
        const handler = handlers[/** @type {keyof typeof handlers} */ (subcommand)];
        if (!handler && subcommand !== 'restore') {
          return `Unknown git subcommand: ${subcommand}. Try 'git help'.`;
        }

        if (!['init', 'clone', 'creds', 'proxy'].includes(subcommand)) {
          const hasGit = yield* Effect.tryPromise({
            try: () => term.fs.exists('.git'),
            catch: (/** @type {unknown} */ cause) => GitError({ operation: 'exists', cause }),
          });
          if (!hasGit) return "Not a git repository. Run 'git init' first.";
        }

        // Discard workdir changes via the shared git-status service (same
        // behavior: NotFoundError → friendly "not tracked" message).
        if (subcommand === 'restore') {
          const gitStatus = yield* GitStatus;
          const filepath = /** @type {string} */ (/** @type {any} */ (parsed).filepath);
          return yield* gitStatus
            .discardFileChanges(term.fs, filepath)
            .pipe(
              Effect.as(`Discarded changes to ${filepath}`),
              Effect.catchAll((/** @type {any} */ e) =>
                e?._tag === 'GitError' && /not tracked by git/.test(e.message)
                  ? Effect.succeed(e.message)
                  : Effect.fail(e),
              ),
            );
        }

        return yield* Effect.tryPromise({
          try: () => handler(parsed, { fs: term.fs, term }),
          catch: (/** @type {unknown} */ cause) => GitError({ operation: subcommand, cause }),
        });
      }).pipe(
        Effect.withSpan(span),
        Effect.withLogSpan(span),
        Effect.mapError((/** @type {GitError | any} */ e) =>
          friendlyError(`${e.operation}: ${e.message ?? String(e)}`),
        ),
        Effect.provide(GitStatusLive),
      )
    );
  },
});
