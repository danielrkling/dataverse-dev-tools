import { command, or, object, optional, argument, string, option, integer, map, message } from '@optique/core';
import { createCommand } from "../terminal.mjs";

// ---------------------------------------------------------------------------
// Config / auth
// ---------------------------------------------------------------------------

const DEFAULT_HOST = 'gitlab.com';

/**
 * Token lookup: repo-scoped store (<repoRoot>/.git/creds.json) first, then the
 * global bootstrap store (/.gitcreds.json). Same format as the `git creds`
 * command: { "<host>": "<token>" }.
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} host
 * @returns {Promise<string | undefined>}
 */
async function getToken(fs, host) {
  for (const file of ['.git/creds.json', '/.gitcreds.json']) {
    try {
      const creds = JSON.parse(await fs.readFile(file, { encoding: 'utf8' }));
      if (creds[host]) return creds[host];
    } catch {}
  }
  return undefined;
}

/**
 * Parses "group/repo", a full https URL or a numeric project id into
 * { host, projectPath (URL-encoded), projectId? }.
 * @param {string} input
 * @returns {{ host: string | null, id: string }}
 */
function parseProject(input) {
  let host = null;
  let path = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (/^https?:\/\//.test(path)) {
    try {
      const url = new URL(path);
      host = url.host;
      path = url.pathname.replace(/^\/+/, '');
    } catch {
      throw new Error(`invalid project URL: ${input}`);
    }
  }
  if (!path) throw new Error(`invalid project: ${input}`);
  if (/^\d+$/.test(path)) return { host, id: path }; // numeric project id
  return { host, id: encodeURIComponent(path) };
}

/**
 * Calls the GitLab v4 REST API. GETs are CORS-friendly and work from static
 * hosts; PRIVATE-TOKEN is sent only when a token is available.
 * @param {{ host: string, token?: string }} auth
 * @param {string} path e.g. `/projects/123/repository/tree`
 * @param {{ method?: string, body?: any, query?: Record<string, string | number | boolean | undefined> }} [opts]
 * @returns {Promise<any>} parsed JSON
 */
async function api(auth, path, opts = {}) {
  const url = new URL(`https://${auth.host}/api/v4${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json' };
  if (auth.token) headers['PRIVATE-TOKEN'] = auth.token;
  let response;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    response = await fetch(url.toString(), {
      method: opts.method ?? 'POST',
      headers,
      body: JSON.stringify(opts.body),
    });
  } else {
    response = await fetch(url.toString(), { method: opts.method ?? 'GET', headers });
  }
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!response.ok) {
    const detail = json?.message || json?.error || text.slice(0, 200);
    throw new Error(`GitLab API ${response.status}: ${detail}`);
  }
  return json;
}

/** @param {any} response @returns {string | null} next keyset cursor */
function nextPageToken(response) {
  return response.headers.get('x-next-page') || null;
}

/**
 * Fetches ALL tree entries for a ref using keyset pagination.
 * @param {ReturnType<typeof makeAuth>} auth
 * @param {string} projectId
 * @param {string} ref
 * @param {(msg: string) => void} log
 * @returns {Promise<Array<{ id: string, type: string, path: string }>>}
 */
async function listTree(auth, projectId, ref, log) {
  /** @type {Array<{ id: string, type: string, path: string }>} */
  const entries = [];
  /** @type {string | null} */
  let cursor = null;
  do {
    const response = await fetchRaw(auth,
      `/projects/${projectId}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&pagination=keyset${cursor ? `&page_token=${encodeURIComponent(cursor)}` : ''}`);
    const batch = await response.json();
    if (Array.isArray(batch)) entries.push(...batch);
    cursor = nextPageToken(response);
    log(`tree: ${entries.length} entries...`);
  } while (cursor);
  return entries;
}

/**
 * Like api() but returns the raw Response (needed for pagination headers).
 * @param {ReturnType<typeof makeAuth>} auth
 * @param {string} pathWithQuery
 */
async function fetchRaw(auth, pathWithQuery) {
  const headers = { Accept: 'application/json' };
  if (auth.token) headers['PRIVATE-TOKEN'] = auth.token;
  const response = await fetch(`https://${auth.host}/api/v4${pathWithQuery}`, { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitLab API ${response.status}: ${text.slice(0, 200)}`);
  }
  return response;
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} inputHost user-supplied host override or null
 * @param {string | null} parsedHost host from a pasted URL
 * @returns {Promise<{ host: string, token?: string }>}
 */
async function makeAuth(fs, inputHost, parsedHost) {
  const host = inputHost || parsedHost || DEFAULT_HOST;
  const token = await getToken(fs, host);
  return { host, token };
}

// ---------------------------------------------------------------------------
// Local mirror repo (isomorphic-git) — keeps `git status` / `git diff` working
// ---------------------------------------------------------------------------

const MANIFEST_FILE = '.gitlab.json';

/**
 * Author for local mirror commits. Mirrors git.mjs's getAuthor: cached in the
 * repo, then Dataverse WhoAmI, then a fallback.
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {Promise<{name: string, email: string}>}
 */
async function getLocalAuthor(fs) {
  try {
    const root = fs.cwd;
    return JSON.parse(await fs.readFile(`${root}/.git/user.json`, { encoding: 'utf8' }));
  } catch {}
  try {
    const headers = { Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' };
    const who = await (await fetch('/api/data/v9.2/WhoAmI', { headers })).json();
    const user = await (await fetch(
      `/api/data/v9.2/systemusers(${who.UserId})?$select=fullname,internalemailaddress`,
      { headers },
    )).json();
    return { name: user.fullname, email: user.internalemailaddress || 'developer@dataverse.org' };
  } catch {
    return { name: 'Developer', email: 'developer@dataverse.org' };
  }
}

/**
 * @param {any[]} row statusMatrix row
 */
function isDirty(row) {
  const [, head, workdir] = row;
  return head === 0 ? workdir !== 0 : workdir !== 1;
}

/**
 * Commits the entire working tree to the local mirror repo.
 * @param {any} git
 * @param {any} gitFs
 * @param {string} dir
 * @param {string} message
 * @param {{ name: string, email: string }} author
 */
async function mirrorCommit(git, gitFs, dir, message, author) {
  await git.init({ fs: gitFs, dir });
  const matrix = await git.statusMatrix({ fs: gitFs, dir, filter: (f) => f !== MANIFEST_FILE });
  for (const [filepath, head, workdir, stage] of matrix) {
    if (workdir === 0 && stage !== 0) await git.remove({ fs: gitFs, dir, filepath });
    else if (workdir !== 0 && workdir !== stage) await git.add({ fs: gitFs, dir, filepath });
  }
  return git.commit({
    fs: gitFs, dir, message,
    author: author ?? { name: 'Developer', email: 'developer@dataverse.org' },
    committer: author ?? { name: 'Developer', email: 'developer@dataverse.org' },
  });
}

/**
 * Reads the manifest describing the last sync with GitLab.
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} root
 */
async function readManifest(fs, root) {
  try {
    return JSON.parse(await fs.readFile(`${root}/${MANIFEST_FILE}`, { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array | ArrayBuffer} data
 * @returns {Promise<string>} lowercase hex sha256
 */
async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', /** @type {ArrayBuffer} */ (data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetches one raw file; returns text content.
 * @param {ReturnType<typeof makeAuth>} auth
 * @param {string} projectId
 * @param {string} filePath
 * @param {string} ref
 */
async function fetchFile(auth, projectId, filePath, ref) {
  const enc = encodeURIComponent(filePath).replace(/%2F/g, '%2F'); // full encode incl slashes
  const response = await fetch(
    `https://${auth.host}/api/v4/projects/${projectId}/repository/files/${enc}/raw?ref=${encodeURIComponent(ref)}`,
    { headers: auth.token ? { 'PRIVATE-TOKEN': auth.token } : {} },
  );
  if (!response.ok) throw new Error(`fetch ${filePath}: HTTP ${response.status}`);
  return response.text();
}

/**
 * Bounded-concurrency map used to avoid hammering the API with hundreds of
 * parallel requests on big clones.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function pooledMap(items, limit, fn) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** @type {Record<string, (parsed: any, ctx: { fs: import('../fs.mjs').WebFileSystem, term?: any }) => Promise<string | undefined>>} */
const handlers = {
  /**
   * gitlab clone <project> [--host H] [--ref R] [--dir D]
   * Downloads the working tree via the REST API (CORS-safe), writes it to
   * <dir>, records sync metadata in .gitlab.json, and creates a local mirror
   * commit so `git status`/`git diff` work immediately.
   */
  async clone(parsed, { fs, term }) {
    const { host, id } = parseProject(parsed.project);
    const auth = await makeAuth(fs, parsed.host, host);
    term.log(`Looking up project ${parsed.project} on ${auth.host}${auth.token ? '' : ' (unauthenticated)'}...`);

    const project = await api(auth, `/projects/${id}`);
    const ref = parsed.ref || project.default_branch;

    // Resolve the head commit of the ref so we can record the synced sha.
    const headCommit = await api(auth, `/projects/${project.id}/repository/commits/${encodeURIComponent(ref)}`);
    const sha = headCommit.id;

    const dir = parsed.dir || project.path.replace(/\.git$/, '');
    term.log(`Cloning ${project.path_with_namespace}@${ref} (${sha.slice(0, 8)}) into ${dir}/ ...`);

    const entries = await listTree(auth, String(project.id), ref, (m) => term.log(m));
    const blobs = entries.filter((e) => e.type === 'blob');
    term.log(`Downloading ${blobs.length} files...`);

    let done = 0;
    await pooledMap(blobs, 8, async (entry) => {
      const content = await fetchFile(auth, String(project.id), entry.path, ref);
      await fs.writeFile(`${fs.cwd}/${dir}/${entry.path}`.replace(/\/+/g, '/'), content);
      done++;
      if (done % 25 === 0) term.log(`downloaded ${done}/${blobs.length}`);
    });

    // Sync metadata for pull/push.
    const root = `${fs.cwd}/${dir}`.replace(/\/+/g, '/');
    /** @type {Record<string, string>} */
    const files = {};
    for (const b of blobs) files[b.path] = b.id;
    await fs.writeFile(`${root}/${MANIFEST_FILE}`, JSON.stringify({
      host: auth.host,
      projectId: project.id,
      projectPath: project.path_with_namespace,
      ref,
      sha,
      files,
    }, null, 2));

    // Local mirror commit so existing git commands work in this folder.
    try {
      const git = await import('isomorphic-git');
      const { makeGitFs } = await import('./git.mjs');
      const gitFs = makeGitFs(fs);
      term.log('Creating local snapshot...');
      await mirrorCommit(git, gitFs, root, `Clone ${project.path_with_namespace}@${sha.slice(0, 8)}`, await getLocalAuthor(fs));
    } catch (/** @type {any} */ e) {
      term.log(`note: local git snapshot skipped (${e.message})`);
    }

    return `Cloned ${blobs.length} files from ${project.path_with_namespace}@${ref} into ${dir}/`;
  },

  /**
   * gitlab pull — applies commits made on GitLab since the last sync.
   * Uses the compare endpoint so only changed files are downloaded.
   */
  async pull(parsed, { fs, term }) {
    const manifest = await readManifest(fs, fs.cwd);
    if (!manifest) return `No ${MANIFEST_FILE} found. Are you inside a gitlab-cloned project?`;

    const auth = await makeAuth(fs, manifest.host, manifest.host);
    const head = await api(auth, `/projects/${manifest.projectId}/repository/commits/${encodeURIComponent(manifest.ref)}`);
    if (head.id === manifest.sha) return 'Already up to date';

    term.log(`Syncing ${manifest.sha.slice(0, 8)} -> ${head.id.slice(0, 8)}...`);
    const compare = await api(auth, `/projects/${manifest.projectId}/repository/compare`, {
      query: { from: manifest.sha, to: head.id },
    });
    const diffs = compare.diffs ?? [];

    let updated = 0, deleted = 0;
    for (const d of diffs) {
      if (d.deleted_file && d.old_path) {
        await fs.unlink(`${fs.cwd}/${d.old_path}`.replace(/\/+/g, '/')).catch(() => {});
        deleted++;
      } else if (d.new_path) {
        const content = await fetchFile(auth, String(manifest.projectId), d.new_path, manifest.ref);
        await fs.writeFile(`${fs.cwd}/${d.new_path}`.replace(/\/+/g, '/'), content);
        updated++;
      }
    }

    // Refresh blob ids from the tree for the changed paths.
    const entries = await listTree(auth, String(manifest.projectId), manifest.ref, () => {});
    /** @type {Record<string, string>} */
    const files = {};
    for (const e of entries) if (e.type === 'blob') files[e.path] = e.id;
    manifest.sha = head.id;
    manifest.files = files;
    await fs.writeFile(`${fs.cwd}/${MANIFEST_FILE}`, JSON.stringify(manifest, null, 2));

    return `Pulled ${updated} file(s) updated, ${deleted} deleted (now at ${head.id.slice(0, 8)})`;
  },

  /**
   * gitlab push -m "message" [--branch B]
   * Builds actions from local changes vs the last-synced state and creates a
   * single multi-file commit via the commits API.
   */
  async push(parsed, { fs, term }) {
    const manifest = await readManifest(fs, fs.cwd);
    if (!manifest) return `No ${MANIFEST_FILE} found. Are you inside a gitlab-cloned project?`;

    // Detect changes by comparing file contents against the recorded tree.
    // We don't rely on the local git index: whatever differs from the last
    // sync gets pushed.
    const auth = await makeAuth(fs, manifest.host, manifest.host);
    const branch = parsed.branch || manifest.ref;

    /** @type {any[]} */
    const actions = [];
    const seen = new Set();

    // Walk local files recursively (excluding .git and manifest).
    /**
     * @param {string} rel
     */
    async function walk(rel) {
      const abs = `${fs.cwd}/${rel}`.replace(/\/+/g, '/');
      for (const name of await fs.readdir(abs)) {
        const childRel = rel ? `${rel}/${name}` : name;
        if (childRel === '.git' || childRel === MANIFEST_FILE) continue;
        const st = await fs.stat(`${fs.cwd}/${childRel}`.replace(/\/+/g, '/'));
        if (st.isDirectory) {
          await walk(childRel);
          continue;
        }
        seen.add(childRel);

        if (manifest.files[childRel] === undefined) {
          // New file: not present at last sync.
          actions.push({ action: 'create', file_path: childRel, content: await readLocal(childRel) });
          continue;
        }

        // Tracked file: compare local content hash against the remote
        // content_sha256 reported by the files API.
        const meta = await api(auth, `/projects/${manifest.projectId}/repository/files/${encodeURIComponent(childRel)}`, {
          query: { ref: branch },
        }).catch(() => null);
        const localSha = await sha256Hex(await readLocalBytes(childRel));
        if (!meta || meta.content_sha256 !== localSha) {
          actions.push({ action: 'update', file_path: childRel, content: await readLocal(childRel) });
        }
      }
    }

    /**
     * @param {string} rel
     * @returns {Promise<string>}
     */
    async function readLocal(rel) {
      return fs.readFile(`${fs.cwd}/${rel}`.replace(/\/+/g, '/'), { encoding: 'utf8' });
    }

    /**
     * @param {string} rel
     * @returns {Promise<Uint8Array>}
     */
    async function readLocalBytes(rel) {
      const buf = await fs.readFile(`${fs.cwd}/${rel}`.replace(/\/+/g, '/'));
      return new Uint8Array(/** @type {ArrayBuffer} */ (buf));
    }

    await walk('');

    // Deletions: tracked at last sync but missing locally.
    for (const path of Object.keys(manifest.files)) {
      if (!seen.has(path) && !(await fs.exists(`${fs.cwd}/${path}`.replace(/\/+/g, '/')))) {
        actions.push({ action: 'delete', file_path: path });
      }
    }

    if (actions.length === 0) return 'Nothing to push: local tree matches last sync';
    term.log(`Pushing ${actions.length} action(s) to ${manifest.projectPath}@${branch}...`);

    const result = await api(auth, `/projects/${manifest.projectId}/repository/commits`, {
      method: 'POST',
      body: {
        branch,
        start_branch: branch === manifest.ref ? undefined : manifest.ref,
        commit_message: parsed.message,
        actions,
      },
    });

    // Refresh manifest to the new remote state.
    manifest.sha = result.id;
    const entries = await listTree(auth, String(manifest.projectId), branch, () => {});
    /** @type {Record<string, string>} */
    const files = {};
    for (const e of entries) if (e.type === 'blob') files[e.path] = e.id;
    manifest.files = files;
    manifest.ref = branch;
    await fs.writeFile(`${fs.cwd}/${MANIFEST_FILE}`, JSON.stringify(manifest, null, 2));

    return `[${result.id.slice(0, 7)}] Pushed ${actions.length} change(s) to ${manifest.projectPath}@${branch}`;
  },

  async log(parsed, { fs }) {
    const manifest = await readManifest(fs, fs.cwd);
    if (!manifest) return `No ${MANIFEST_FILE} found. Are you inside a gitlab-cloned project?`;
    const auth = await makeAuth(fs, manifest.host, manifest.host);
    const commits = await api(auth, `/projects/${manifest.projectId}/repository/commits`, {
      query: { ref_name: manifest.ref, per_page: parsed.depth || 10 },
    });
    return commits.map((/** @type {any} */ c) => {
      const date = new Date(c.created_at).toLocaleString();
      return `${c.id.slice(0, 7)} ${date} ${c.author_name}  ${c.title}`;
    }).join('\n');
  },

  async status(parsed, { fs }) {
    const manifest = await readManifest(fs, fs.cwd);
    if (!manifest) return `No ${MANIFEST_FILE} found. Are you inside a gitlab-cloned project?`;
    const lines = [
      `Project:   ${manifest.projectPath}`,
      `Remote:    https://${manifest.host}/${manifest.projectPath}`,
      `Branch:    ${manifest.ref}`,
      `Synced at: ${manifest.sha.slice(0, 8)}`,
      `Files:     ${Object.keys(manifest.files).length}`,
    ];
    return lines.join('\n');
  },

  async branches(parsed, { fs }) {
    const manifest = await readManifest(fs, fs.cwd);
    if (!manifest && !parsed.project) {
      return 'Not inside a gitlab-cloned project. Specify one: gitlab branches group/repo';
    }
    const { host, id } = manifest ? { host: manifest.host, id: String(manifest.projectId) } : parseProject(parsed.project);
    const auth = await makeAuth(fs, host, host);
    const branches = await api(auth, `/projects/${id}/repository/branches`);
    return branches.map((/** @type {any} */ b) =>
      b.name === manifest?.ref ? `* ${b.name}` : `  ${b.name}`,
    ).join('\n');
  },

  async help() {
    return [
      'Usage: gitlab <subcommand> [args]',
      '',
      'Subcommands: clone, pull, push, log, status, branches, help',
      '',
      'Uses the GitLab REST API directly (works from static hosts / Dataverse).',
      'Tokens are looked up in .gitcreds stores set via `git creds set <host> <token>`.',
      '',
      'Examples:',
      '  gitlab clone group/repo',
      '  gitlab clone https://gitlab.example.com/group/repo --host gitlab.example.com',
      '  cd repo && gitlab pull',
      '  gitlab push -m "update webresources" [-b feature-branch]',
    ].join('\n');
  },
};

const subcommandParsers = {
  clone: map(object({
    project: argument(string({ metavar: 'PROJECT' })),
    host: optional(option('--host', string({ metavar: 'HOST' }))),
    ref: optional(option('-b', '--ref', string({ metavar: 'REF' }))),
    dir: optional(argument(string({ metavar: 'DIR' }))),
  }), (r) => ({ subcommand: 'clone', ...r })),
  pull: map(object({}), () => ({ subcommand: 'pull' })),
  push: map(object({
    message: option('-m', '--message', string({ metavar: 'MESSAGE' })),
    branch: optional(option('-b', '--branch', string({ metavar: 'BRANCH' }))),
  }), (r) => ({ subcommand: 'push', ...r })),
  log: map(object({
    depth: optional(argument(integer({ metavar: 'DEPTH' }))),
  }), (r) => ({ subcommand: 'log', ...r })),
  status: map(object({}), () => ({ subcommand: 'status' })),
  branches: map(object({
    project: optional(argument(string({ metavar: 'PROJECT' }))),
  }), (r) => ({ subcommand: 'branches', ...r })),
  help: map(object({}), () => ({ subcommand: 'help' })),
};

const gitlabParser = or(
  command('clone', subcommandParsers.clone),
  command('pull', subcommandParsers.pull),
  command('push', subcommandParsers.push),
  command('log', subcommandParsers.log),
  command('status', subcommandParsers.status),
  command('branches', subcommandParsers.branches),
  command('help', subcommandParsers.help),
);

export default createCommand({
  name: "gitlab",
  aliases: ["gl"],
  parser: gitlabParser,
  description: message`GitLab integration via the REST API`,
  usage: message`gitlab <subcommand> [args...]`,
  brief: message`GitLab integration via the REST API`,
  execute: async (parsed, term) => {
    const subcommand = /** @type {string} */ (parsed.subcommand);
    const handler = handlers[/** @type {keyof typeof handlers} */ (subcommand)];
    if (!handler) return `Unknown gitlab subcommand: ${subcommand}. Try 'gitlab help'.`;

    try {
      const result = await handler(parsed, { fs: term.fs, term });
      if (result != null) return result;
    } catch (/** @type {any} */ e) {
      term.error(`gitlab ${subcommand}: ${e.message}`);
    }
  },
});
