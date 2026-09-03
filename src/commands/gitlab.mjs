import { command, or, object, optional, argument, string, option, integer, map, message } from '@optique/core';
import { Effect, Duration } from "effect";
import { createCommand } from "../services/commands.mjs";
import { makeGitFs } from "./git.mjs";

// ---------------------------------------------------------------------------
// Typed errors (JSDoc-friendly _tag factories — see effects/dataverse-service.mjs)
// ---------------------------------------------------------------------------

/**
 * HTTP failure from the GitLab REST API.
 * @typedef {{ _tag: "HttpError", status: number, path: string, detail: string, message: string }} HttpError
 */
const HttpError = (/** @type {{ status: number, path: string, detail: string, message?: string }} */ props) => ({
    _tag: /** @type {const} */ ("HttpError"),
    message: `GitLab API ${props.status}: ${props.detail}`,
    ...props,
});

/**
 * Network / transport failure (fetch rejection, invalid payload).
 * @typedef {{ _tag: "DecodeError", path: string, cause: unknown, message: string }} DecodeError
 */
const DecodeError = (/** @type {{ path: string, cause: unknown }} */ props) => ({
    _tag: /** @type {const} */ ("DecodeError"),
    message: /** @type {any} */ (props.cause)?.message ?? `request failed for ${props.path}`,
    ...props,
});

// ---------------------------------------------------------------------------
// Config / auth
// ---------------------------------------------------------------------------

const DEFAULT_HOST = 'gitlab.com';

/**
 * Parses "group/repo", a full https URL or a numeric project id into
 * { host, id } where id is URL-encoded or numeric.
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
 * Calls the GitLab v4 REST API as an Effect. GETs are CORS-friendly and work
 * from static hosts; PRIVATE-TOKEN is sent only when a token is available.
 * 30s timeout per request, typed HttpError/DecodeError — mirroring
 * effects/dataverse-service.mjs's request().
 *
 * @param {{ host: string, token?: string }} auth
 * @param {string} path e.g. `/projects/123/repository/tree`
 * @param {{ method?: string, body?: any, query?: Record<string, string | number | boolean | undefined> }} [opts]
 * @returns {Effect.Effect<any, HttpError | DecodeError | import("effect/Cause").TimeoutException, never>} parsed JSON (null for empty bodies)
 */
function api(auth, path, opts = {}) {
  return Effect.tryPromise({
    try: async (signal) => {
      const url = new URL(`https://${auth.host}/api/v4${path}`);
      for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
      /** @type {Record<string, string>} */
      const headers = { Accept: 'application/json' };
      if (auth.token) headers['PRIVATE-TOKEN'] = auth.token;
      /** @type {RequestInit} */
      const init = { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, signal };
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      const response = await fetch(url.toString(), init);
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
      if (!response.ok) {
        const detail = /** @type {any} */ (json)?.message || /** @type {any} */ (json)?.error || text.slice(0, 200);
        throw HttpError({ status: response.status, path, detail });
      }
      return json;
    },
    catch: (/** @type {unknown} */ cause) =>
      /** @type {any} */ (cause)?._tag === 'HttpError'
        ? /** @type {HttpError} */ (cause)
        : DecodeError({ path, cause }),
  }).pipe(
    Effect.withSpan('gitlab.request', { attributes: { path } }),
    Effect.withLogSpan('gitlab.request'),
    Effect.timeout(Duration.seconds(30)),
  );
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
 * @returns {Effect.Effect<Array<{ id: string, type: string, path: string }>, HttpError | DecodeError | import("effect/Cause").TimeoutException, never>}
 */
function listTree(auth, projectId, ref, log) {
  return Effect.gen(function* () {
    /** @type {Array<{ id: string, type: string, path: string }>} */
    const entries = [];
    /** @type {string | null} */
    let cursor = null;
    do {
      const response = yield* fetchRaw(auth,
        `/projects/${projectId}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&pagination=keyset${cursor ? `&page_token=${encodeURIComponent(cursor)}` : ''}`);
      const batch = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (/** @type {unknown} */ cause) => DecodeError({ path: 'repository/tree', cause }),
      });
      if (Array.isArray(batch)) entries.push(...batch);
      cursor = nextPageToken(response);
      log(`tree: ${entries.length} entries...`);
    } while (cursor);
    return entries;
  });
}

/**
 * Like api() but returns the raw Response (needed for pagination headers).
 * @param {ReturnType<typeof makeAuth>} auth
 * @param {string} pathWithQuery
 * @returns {Effect.Effect<Response, HttpError | DecodeError | import("effect/Cause").TimeoutException, never>}
 */
function fetchRaw(auth, pathWithQuery) {
  return Effect.tryPromise({
    try: async (signal) => {
      /** @type {Record<string, string>} */
      const headers = { Accept: 'application/json' };
      if (auth.token) headers['PRIVATE-TOKEN'] = auth.token;
      const response = await fetch(`https://${auth.host}/api/v4${pathWithQuery}`, { headers, signal });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw HttpError({ status: response.status, path: pathWithQuery, detail: text.slice(0, 200) });
      }
      return response;
    },
    catch: (/** @type {unknown} */ cause) =>
      /** @type {any} */ (cause)?._tag === 'HttpError'
        ? /** @type {HttpError} */ (cause)
        : DecodeError({ path: pathWithQuery, cause }),
  }).pipe(
    Effect.withSpan('gitlab.request', { attributes: { path: pathWithQuery } }),
    Effect.withLogSpan('gitlab.request'),
    Effect.timeout(Duration.seconds(30)),
  );
}

/**
 * Builds the auth context for API calls. The token lives in the project's
 * .gitlab.json manifest (set once at clone time) — credentials are always
 * scoped to a project.
 * @param {string} host
 * @param {string | undefined} token
 * @returns {{ host: string, token?: string }}
 */
function makeAuth(host, token) {
  return { host: host || DEFAULT_HOST, token };
}

// ---------------------------------------------------------------------------
// Local mirror repo (isomorphic-git) — keeps `git status` / `git diff` working
// ---------------------------------------------------------------------------

/** Lives inside .git so it is hidden from listings and can never be committed. */
const MANIFEST_FILE = '.git/gitlab.json';

/**
 * Author for local mirror commits. Mirrors git.mjs's getAuthor: cached in the
 * repo, then Dataverse WhoAmI, then a fallback.
 * @param {import('../services/fs.mjs').WebFileSystem} fs
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
  const matrix = await git.statusMatrix({ fs: gitFs, dir, filter: (/** @type {string} */ f) => !f.startsWith('.git') });
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
 * @param {import('../services/fs.mjs').WebFileSystem} fs
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
 * Computes the git blob object id (sha1) of file content — the same id the
 * tree API returns. This makes push's change detection completely offline.
 * @param {Uint8Array} content
 * @returns {Promise<string>} 40-char hex sha1
 */
async function gitBlobSha(content) {
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const data = new Uint8Array(header.length + content.length);
  data.set(header);
  data.set(content, header.length);
  const digest = await crypto.subtle.digest('SHA-1', /** @type {BufferSource} */ (data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Builds a create/update action, choosing text or base64 encoding based on
 * whether the content round-trips as UTF-8. Binary files (images, fonts,
 * wasm...) must not go through the text path or they get corrupted.
 * @param {'create' | 'update'} action
 * @param {string} filePath
 * @param {Uint8Array} bytes
 * @returns {any}
 */
function actionWithContent(action, filePath, bytes) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // Re-encode and compare: identical means it is valid UTF-8 text.
  if (new TextEncoder().encode(text).every((b, i) => b === bytes[i])) {
    return { action, file_path: filePath, content: text };
  }
  return {
    action,
    file_path: filePath,
    content: base64FromBytes(bytes),
    encoding: 'base64',
  };
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base64FromBytes(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Splits actions into chunks that stay under a byte budget and item count so
 * each commit request comfortably clears GitLab's size limits.
 * @param {any[]} actions
 * @param {number} maxBytes approximate content byte budget per chunk
 * @param {number} maxCount max actions per chunk
 * @returns {any[][]}
 */
function chunkActions(actions, maxBytes, maxCount) {
  /** @type {any[][]} */
  const chunks = [[]];
  let size = 0;
  for (const a of actions) {
    const cost = a.content?.length ?? 0;
    const current = chunks[chunks.length - 1];
    if (current.length > 0 && (size + cost > maxBytes || current.length >= maxCount)) {
      chunks.push([]);
      size = 0;
    }
    chunks[chunks.length - 1].push(a);
    size += cost;
  }
  return chunks;
}

/** @param {number} bytes @returns {string} */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Build an Error carrying a single friendly line (no stack) — Cause.pretty
 * in the registry then renders exactly one line per command failure.
 * @param {string} message
 * @returns {Error}
 */
function friendlyError(message) {
  const err = new Error(message);
  delete err.stack;
  return err;
}

/**
 * Lifts a local async operation (workspace fs / crypto / dynamic import) into
 * an Effect with a plain Error error channel.
 * @template A
 * @param {() => Promise<A>} fn
 * @returns {Effect.Effect<A, Error, never>}
 */
function lift(fn) {
  return Effect.tryPromise({
    try: fn,
    catch: (/** @type {unknown} */ cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });
}

/**
 * Fetches one raw file; returns text content.
 * @param {ReturnType<typeof makeAuth>} auth
 * @param {string} projectId
 * @param {string} filePath
 * @param {string} ref
 * @returns {Effect.Effect<string, HttpError | DecodeError | import("effect/Cause").TimeoutException, never>}
 */
function fetchFile(auth, projectId, filePath, ref) {
  const enc = encodeURIComponent(filePath); // full encode incl slashes
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(
        `https://${auth.host}/api/v4/projects/${projectId}/repository/files/${enc}/raw?ref=${encodeURIComponent(ref)}`,
        { headers: auth.token ? { 'PRIVATE-TOKEN': auth.token } : {}, signal },
      );
      if (!response.ok) {
        throw HttpError({
          status: response.status,
          path: filePath,
          detail: 'raw file',
          message: `fetch ${filePath}: HTTP ${response.status}`,
        });
      }
      return response.text();
    },
    catch: (/** @type {unknown} */ cause) =>
      /** @type {any} */ (cause)?._tag === 'HttpError'
        ? /** @type {HttpError} */ (cause)
        : DecodeError({ path: filePath, cause }),
  }).pipe(
    Effect.withSpan('gitlab.request', { attributes: { path: filePath } }),
    Effect.withLogSpan('gitlab.request'),
    Effect.timeout(Duration.seconds(30)),
  );
}

/**
 * Bounded-concurrency mapping is now done with `Effect.forEach`
 * ({ concurrency: 8 }) at the call sites that used to use pooledMap.
 */

/** @type {Record<string, (parsed: any, ctx: { fs: import('../services/fs.mjs').WebFileSystem, term?: any }) => Effect.Effect<string | undefined, any>>} */
const handlers = {
  /**
   * gitlab clone <project> [--host H] [--ref R] [--dir D]
   * Downloads the working tree via the REST API (CORS-safe), writes it to
   * <dir>, records sync metadata in .gitlab.json, and creates a local mirror
   * commit so `git status`/`git diff` work immediately.
   */
  clone: (parsed, { fs, term }) =>
    Effect.gen(function* () {
      const { host, id } = yield* Effect.try({
        try: () => parseProject(parsed.project),
        catch: (/** @type {unknown} */ cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });
      const auth = makeAuth(parsed.host || host || '', parsed.token);
      term.log(`Looking up project ${parsed.project} on ${auth.host}...`);

      const project = yield* api(auth, `/projects/${id}`);
      const ref = parsed.ref || project.default_branch;

      // Resolve the head commit of the ref so we can record the synced sha.
      const headCommit = yield* api(auth, `/projects/${project.id}/repository/commits/${encodeURIComponent(ref)}`);
      const sha = headCommit.id;

      const dir = parsed.dir || project.path.replace(/\.git$/, '');
      term.log(`Cloning ${project.path_with_namespace}@${ref} (${sha.slice(0, 8)}) into ${dir}/ ...`);

      const entries = yield* listTree(auth, String(project.id), ref, (/** @type {string} */ m) => term.log(m));
      const blobs = entries.filter((/** @type {any} */ e) => e.type === 'blob');
      term.log(`Downloading ${blobs.length} files...`);

      yield* Effect.forEach(
        blobs,
        (/** @type {any} */ entry, index) =>
          Effect.gen(function* () {
            const content = yield* fetchFile(auth, String(project.id), entry.path, ref);
            yield* lift(() => fs.writeFile(`${fs.cwd}/${dir}/${entry.path}`.replace(/\/+/g, '/'), content));
            if ((index + 1) % 25 === 0) term.log(`downloaded ${index + 1}/${blobs.length}`);
          }),
        { concurrency: 8 },
      );

      // Sync metadata for pull/push.
      const root = `${fs.cwd}/${dir}`.replace(/\/+/g, '/');
      /** @type {Record<string, string>} */
      const files = {};
      for (const b of blobs) files[b.path] = b.id;
      yield* lift(() => fs.writeFile(`${root}/${MANIFEST_FILE}`, JSON.stringify({
        host: auth.host,
        token: auth.token,
        projectId: project.id,
        projectPath: project.path_with_namespace,
        ref,
        sha,
        files,
      }, null, 2)));

      // Local mirror commit so existing git commands work in this folder.
      yield* lift(async () => {
        const git = await import('isomorphic-git');
        const gitFs = makeGitFs(fs);
        term.log('Creating local snapshot...');
        await mirrorCommit(git, gitFs, root, `Clone ${project.path_with_namespace}@${sha.slice(0, 8)}`, await getLocalAuthor(fs));
      }).pipe(Effect.catchAll((/** @type {any} */ e) =>
        Effect.sync(() => term.log(`note: local git snapshot skipped (${e.message})`)),
      ));

      return `Cloned ${blobs.length} files from ${project.path_with_namespace}@${ref} into ${dir}/`;
    }),

  /**
   * gitlab pull — applies commits made on GitLab since the last sync.
   * Uses the compare endpoint so only changed files are downloaded.
   */
  /**
   * gitlab pull [--force]
   * Applies commits made on GitLab since the last sync. Files that were
   * modified locally since the sync are treated as conflicts and left alone
   * unless --force is given.
   */
  pull: (parsed, { fs, term }) =>
    Effect.gen(function* () {
      const manifest = yield* lift(() => readManifest(fs, fs.cwd));
      if (!manifest) return `No ${MANIFEST_FILE} found. Are you inside a gitlab-cloned project?`;

      const auth = makeAuth(manifest.host, manifest.token);
      const head = yield* api(auth, `/projects/${manifest.projectId}/repository/commits/${encodeURIComponent(manifest.ref)}`);
      if (head.id === manifest.sha) return 'Already up to date';

      term.log(`Syncing ${manifest.sha.slice(0, 8)} -> ${head.id.slice(0, 8)}...`);
      const compare = yield* api(auth, `/projects/${manifest.projectId}/repository/compare`, {
        query: { from: manifest.sha, to: head.id },
      });
      const diffs = compare.diffs ?? [];

      /**
       * @param {string} rel
       * @returns {Effect.Effect<boolean, Error, never>}
       */
      const isLocallyModified = (rel) =>
        Effect.gen(function* () {
          try {
            const buf = new Uint8Array(/** @type {ArrayBuffer} */ (
              yield* lift(() => fs.readFile(`${fs.cwd}/${rel}`.replace(/\/+/g, '/')))
            ));
            return (yield* lift(() => gitBlobSha(buf))) !== manifest.files[rel];
          } catch {
            return false; // missing locally -> nothing to clobber
          }
        });

      let updated = 0, deleted = 0;
      /** @type {string[]} */
      const conflicts = [];
      /** @type {Set<string>} */
      const conflictedPaths = new Set();

      for (const d of diffs) {
        // A rename shows up as one diff entry with old_path + new_path.
        /** @type {string[]} */
        const touched = [];
        if (d.deleted_file && d.old_path) touched.push(d.old_path);
        if (d.new_path) touched.push(d.new_path);

        const dirty = [];
        for (const p of touched) {
          if (!parsed.force && (yield* lift(() => fs.exists(`${fs.cwd}/${p}`.replace(/\/+/g, '/')))) && (yield* isLocallyModified(p))) {
            dirty.push(p);
          }
        }
        if (dirty.length > 0) {
          for (const p of dirty) {
            conflicts.push(`${p} (${d.deleted_file ? 'deleted' : d.renamed_file ? 'renamed' : 'modified'} remotely)`);
            conflictedPaths.add(p);
          }
          continue;
        }

        if (d.deleted_file && d.old_path && !conflictedPaths.has(d.old_path)) {
          yield* lift(() => fs.unlink(`${fs.cwd}/${d.old_path}`.replace(/\/+/g, '/')).catch(() => {}));
          deleted++;
        } else if (d.new_path) {
          const content = yield* fetchFile(auth, String(manifest.projectId), d.new_path, manifest.ref);
          yield* lift(() => fs.writeFile(`${fs.cwd}/${d.new_path}`.replace(/\/+/g, '/'), content));
          updated++;
        }
      }

      // Refresh blob ids from the tree. Conflicted paths keep their OLD
      // recorded id so push still sees them as changed relative to remote
      // instead of silently treating them as in-sync.
      const entries = yield* listTree(auth, String(manifest.projectId), manifest.ref, () => {});
      /** @type {Record<string, string>} */
      const files = {};
      for (const e of entries) if (e.type === 'blob') files[e.path] = e.id;
      for (const p of conflictedPaths) {
        if (manifest.files[p] !== undefined) files[p] = manifest.files[p];
      }
      manifest.sha = head.id;
      manifest.files = files;
      yield* lift(() => fs.writeFile(`${fs.cwd}/${MANIFEST_FILE}`, JSON.stringify(manifest, null, 2)));

      const parts = [`Pulled ${updated} file(s) updated, ${deleted} deleted (now at ${head.id.slice(0, 8)})`];
      if (conflicts.length > 0) {
        term.log('CONFLICTS — kept your local versions:');
        for (const c of conflicts) term.log(`  ${c}`);
        parts.push(`${conflicts.length} conflicted file(s) kept local — edit/merge manually, then push.`);
      }
      return parts.join('\n');
    }),

  /**
   * gitlab push -m "message" [--branch B]
   * Builds actions by comparing local files against the blob ids recorded in
   * the manifest at clone/pull time — entirely offline. Git blob sha1 is
   * sha1("blob <size>\0" + content), so no per-file API round-trips are
   * needed. Large change sets are split into multiple commits to stay under
   * the API's request-size limits.
   */
  push: (parsed, { fs, term }) =>
    Effect.gen(function* () {
      const manifest = yield* lift(() => readManifest(fs, fs.cwd));
      if (!manifest) return `No ${MANIFEST_FILE} found. Are you inside a gitlab-cloned project?`;

      const auth = makeAuth(manifest.host, manifest.token);
      const branch = parsed.branch || manifest.ref;

      // Stale-push guard: the commits API happily commits onto whatever the
      // branch tip currently is, so pushing on top of someone else's newer
      // commit would silently overwrite their file contents. Refuse unless
      // the branch is where we last synced (or --force was given).
      if (!parsed.force) {
        const head = yield* api(auth, `/projects/${manifest.projectId}/repository/commits/${encodeURIComponent(branch)}`);
        if (head.id !== manifest.sha) {
          return [
            `Remote ${branch} has moved ahead (${manifest.sha.slice(0, 8)} -> ${head.id.slice(0, 8)}), likely by someone else.`,
            "Run 'gitlab pull' first to integrate their changes, then push again.",
            'Use gitlab push --force to overwrite anyway (may clobber their changes).',
          ].join('\n');
        }
      }

      /** @type {any[]} */
      const actions = [];
      const seen = new Set();

      /**
       * @param {string} rel
       * @returns {Effect.Effect<Uint8Array, Error, never>}
       */
      const readLocalBytes = (rel) =>
        lift(async () => {
          const buf = await fs.readFile(`${fs.cwd}/${rel}`.replace(/\/+/g, '/'));
          return new Uint8Array(/** @type {ArrayBuffer} */ (buf));
        });

      // Walk local files recursively (excluding .git and manifest).
      /**
       * @param {string} rel
       * @returns {Effect.Effect<void, Error | HttpError | DecodeError, never>}
       */
      const walk = (rel) =>
        Effect.gen(function* () {
          const abs = `${fs.cwd}/${rel}`.replace(/\/+/g, '/');
          for (const name of /** @type {string[]} */ (yield* lift(() => fs.readdir(abs)))) {
            const childRel = rel ? `${rel}/${name}` : name;
            if (childRel === '.git') continue;
            const st = yield* lift(() => fs.stat(`${fs.cwd}/${childRel}`.replace(/\/+/g, '/')));
            if (st.isDirectory) {
              yield* walk(childRel);
              continue;
            }
            seen.add(childRel);

            const bytes = yield* readLocalBytes(childRel);
            const localBlobId = yield* lift(() => gitBlobSha(bytes));

            if (manifest.files[childRel] === undefined) {
              // New file: not present at last sync.
              actions.push(actionWithContent('create', childRel, bytes));
            } else if (manifest.files[childRel] !== localBlobId) {
              // Changed vs last sync — zero network calls for this comparison.
              actions.push(actionWithContent('update', childRel, bytes));
            }
          }
        });

      yield* walk('');

      // Deletions: tracked at last sync but missing locally.
      for (const path of Object.keys(manifest.files)) {
        if (!seen.has(path)) {
          if (!(yield* lift(() => fs.exists(`${fs.cwd}/${path}`.replace(/\/+/g, '/'))))) {
            actions.push({ action: 'delete', file_path: path });
          } else {
            // Case-only rename or similar oddity: refresh tracking so it does
            // not show up as deleted forever.
            manifest.files[path] = yield* Effect.flatMap(readLocalBytes(path), (bytes) => lift(() => gitBlobSha(bytes)));
          }
        }
      }

      if (actions.length === 0) return 'Nothing to push: local tree matches last sync';

      const totalBytes = actions.reduce((/** @type {number} */ sum, /** @type {any} */ a) => sum + (a.content?.length ?? 0), 0);
      term.log(`Pushing ${actions.length} action(s), ~${formatSize(totalBytes)} of content...`);

      // Split into chunks that stay well under the commits API limits
      // (requests >20MB get rate-limited, hard limit is 300MB).
      const chunks = chunkActions(actions, 5 * 1024 * 1024, 200);
      if (chunks.length > 1) term.log(`Splitting into ${chunks.length} commit(s)...`);

      /** @type {string | undefined} */
      let lastSha;
      for (let i = 0; i < chunks.length; i++) {
        const suffix = chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : '';
        term.log(`Committing ${chunks[i].length} action(s)${suffix}...`);
        const result = yield* api(auth, `/projects/${manifest.projectId}/repository/commits`, {
          method: 'POST',
          body: {
            branch,
            start_branch: branch === manifest.ref && i === 0 ? undefined : branch,
            commit_message: parsed.message + suffix,
            actions: chunks[i],
          },
        });
        lastSha = result.id;
        term.log(`[${result.id.slice(0, 7)}] committed ${chunks[i].length} action(s)${suffix}`);
      }

      // Refresh manifest to the new remote state.
      manifest.sha = /** @type {string} */ (lastSha);
      const entries = yield* listTree(auth, String(manifest.projectId), branch, () => {});
      /** @type {Record<string, string>} */
      const files = {};
      for (const e of entries) if (e.type === 'blob') files[e.path] = e.id;
      manifest.files = files;
      manifest.ref = branch;
      yield* lift(() => fs.writeFile(`${fs.cwd}/${MANIFEST_FILE}`, JSON.stringify(manifest, null, 2)));

      const verb = chunks.length > 1 ? ` in ${chunks.length} commit(s)` : '';
      return `Pushed ${actions.length} change(s) to ${manifest.projectPath}@${branch}${verb}`;
    }),

  log: (parsed, { fs }) =>
    Effect.gen(function* () {
      const manifest = yield* lift(() => readManifest(fs, fs.cwd));
      if (!manifest) return `No ${MANIFEST_FILE} found. Are you inside a gitlab-cloned project?`;
      const auth = makeAuth(manifest.host, manifest.token);
      const commits = yield* api(auth, `/projects/${manifest.projectId}/repository/commits`, {
        query: { ref_name: manifest.ref, per_page: parsed.depth || 10 },
      });
      return commits.map((/** @type {any} */ c) => {
        const date = new Date(c.created_at).toLocaleString();
        return `${c.id.slice(0, 7)} ${date} ${c.author_name}  ${c.title}`;
      }).join('\n');
    }),

  status: (parsed, { fs }) =>
    Effect.gen(function* () {
      const manifest = yield* lift(() => readManifest(fs, fs.cwd));
      if (!manifest) return `No ${MANIFEST_FILE} found. Are you inside a gitlab-cloned project?`;
      const lines = [
        `Project:   ${manifest.projectPath}`,
        `Remote:    https://${manifest.host}/${manifest.projectPath}`,
        `Branch:    ${manifest.ref}`,
        `Synced at: ${manifest.sha.slice(0, 8)}`,
        `Files:     ${Object.keys(manifest.files).length}`,
      ];
      return lines.join('\n');
    }),

  branches: (parsed, { fs }) =>
    Effect.gen(function* () {
      const manifest = yield* lift(() => readManifest(fs, fs.cwd));
      if (!manifest) return `No ${MANIFEST_FILE} found. Are you inside a gitlab-cloned project?`;
      const auth = makeAuth(manifest.host, manifest.token);
      const branches = yield* api(auth, `/projects/${manifest.projectId}/repository/branches`);
      return branches.map((/** @type {any} */ b) =>
        b.name === manifest.ref ? `* ${b.name}` : `  ${b.name}`,
      ).join('\n');
    }),

  help: () =>
    Effect.succeed([
      'Usage: gitlab <subcommand> [args]',
      '',
      'Subcommands: clone, pull, push, log, status, branches, help',
      '',
      'Uses the GitLab REST API directly (works from static hosts / Dataverse).',
      'The access token is provided once at clone time (-t) and stored in the',
      "project's .git/gitlab.json — credentials are always scoped to a project.",
      '',
      'Examples:',
      '  gitlab clone group/repo -t <PAT>',
      '  gitlab clone https://gitlab.example.com/group/repo --host gitlab.example.com -t <PAT>',
      '  cd repo && gitlab pull [--force]',
      '  gitlab push -m "update webresources" [-b feature-branch] [--force]',
    ].join('\n')),
};

/**
 * Programmatic entry points used by the `git` command: repos cloned via
 * `gitlab clone` carry a .git/gitlab.json manifest and sync through the
 * CORS-safe REST API. `git push`/`git pull` detect the manifest and call
 * these instead of isomorphic-git's smart-HTTP transfer.
 *
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {any} term
 * @param {{ force?: boolean }} [options]
 * @returns {Effect.Effect<string | undefined, Error>}
 */
export function apiPullEffect(fs, term, options = {}) {
  return handlers.pull({ force: options.force }, { fs, term });
}

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {any} term
 * @param {{ message?: string, branch?: string, force?: boolean }} [options]
 * @returns {Effect.Effect<string | undefined, Error>}
 */
export function apiPushEffect(fs, term, options = {}) {
  return handlers.push(
    { message: options.message, branch: options.branch, force: options.force },
    { fs, term },
  );
}

/**
 * Run a gitlab handler Effect for legacy Promise callers, rethrowing the
 * mapped friendly Error on failure.
 * @template A
 * @param {Effect.Effect<A, Error>} effect
 * @returns {Promise<A>}
 */
function runGitlab(effect) {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (exit._tag === "Failure") {
      const cause = /** @type {any} */ (exit.cause);
      throw cause?.error ?? new Error("gitlab failure");
    }
    return /** @type {A} */ (exit.value);
  });
}

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {any} term
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<string | undefined>}
 */
export function apiPull(fs, term, options = {}) {
  return runGitlab(apiPullEffect(fs, term, options));
}

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {any} term
 * @param {{ message?: string, branch?: string, force?: boolean }} [options]
 * @returns {Promise<string | undefined>}
 */
export function apiPush(fs, term, options = {}) {
  return runGitlab(apiPushEffect(fs, term, options));
}

const subcommandParsers = {
  clone: map(object({
    project: argument(string({ metavar: 'PROJECT' })),
    token: option('-t', '--token', string({ metavar: 'PAT' })),
    host: optional(option('--host', string({ metavar: 'HOST' }))),
    ref: optional(option('-b', '--ref', string({ metavar: 'REF' }))),
    dir: optional(argument(string({ metavar: 'DIR' }))),
  }), (r) => ({ subcommand: 'clone', ...r })),
  pull: map(object({
    force: optional(option('--force')),
  }), (r) => ({ subcommand: 'pull', ...r })),
  push: map(object({
    message: option('-m', '--message', string({ metavar: 'MESSAGE' })),
    branch: optional(option('-b', '--branch', string({ metavar: 'BRANCH' }))),
    force: optional(option('--force')),
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
  /**
   * Effect-based execution: one span per subcommand (`gitlab.<op>`), typed
   * HttpError/DecodeError mapped to a single friendly Error for the registry.
   *
   * @param {any} parsed
   * @param {import("../types/terminal.d.ts").Terminal} term
   * @returns {Effect.Effect<string | undefined, Error>}
   */
  timeoutSeconds: 300, // pull/push chunk large trees over the REST API
  executeEffect: (parsed, term) => {
    const subcommand = /** @type {string} */ (parsed.subcommand);
    const handler = handlers[/** @type {keyof typeof handlers} */ (subcommand)];
    if (!handler) return Effect.succeed(`Unknown gitlab subcommand: ${subcommand}. Try 'gitlab help'.`);

    return /** @type {Effect.Effect<string | undefined, Error>} */ (
      handler(parsed, { fs: term.fs, term }).pipe(
        Effect.withSpan(`gitlab.${subcommand}`),
        Effect.withLogSpan(`gitlab.${subcommand}`),
        Effect.mapError((/** @type {any} */ e) =>
          friendlyError(`gitlab ${subcommand}: ${e?.message ?? String(e)}`),
        ),
      )
    );
  },
});
