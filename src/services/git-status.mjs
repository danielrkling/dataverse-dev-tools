/**
 * Git status + HEAD content helpers as an Effect service.
 *
 * Shared by the file tree (badges) and the editor pane (Monaco diff view).
 * All paths flowing through here are workspace-root-relative, matching the
 * tree's canonical paths. isomorphic-git is loaded lazily (Effect.cached over
 * a dynamic import) so nothing pays for it until a repo is actually present.
 *
 * Consumers of the legacy Promise exports (components/file-tree.mjs):
 * - getGitStatusEntries (tree badges, debounced refresh)
 * - readHeadFile        (editor diff view)
 * - discardFileChanges  (tree context menu "discard changes")
 *
 * New code can `yield* GitStatus` instead, provided via GitStatusLive.
 */
import { Context, Effect, Layer, Ref } from "effect";
import { makeGitFs, statusLabel } from "../commands/git.mjs";

// ---------------------------------------------------------------------------
// Typed errors (JSDoc-friendly _tag factories — see effects/dataverse-service.mjs)
// ---------------------------------------------------------------------------

/** @typedef {{ _tag: "GitError", operation: string, path?: string, cause: unknown, message: string }} GitError */
export const GitError = (/** @type {{ operation: string, path?: string, cause: unknown }} */ props) => ({
    _tag: /** @type {const} */ ("GitError"),
    message: /** @type {any} */ (props.cause)?.message ?? `git ${props.operation} failed`,
    ...props,
});

/** @typedef {{ _tag: "NoRepoError", operation: string, message: string }} NoRepoError */
export const NoRepoError = (/** @type {string} */ operation) => ({
    _tag: /** @type {const} */ ("NoRepoError"),
    operation,
    message: "not a git repository",
});

/** @typedef {GitError | NoRepoError} GitStatusError */

/** @typedef {import("@pierre/trees").GitStatusEntry} GitStatusEntry */
/** @typedef {import("./fs.mjs").WebFileSystem} WebFileSystem */

// ---------------------------------------------------------------------------
// Module state (cached git module, one-time index-corruption warning)
// ---------------------------------------------------------------------------

/** Lazy, cached isomorphic-git module load. NOTE: Effect.cached returns
 * Effect<Effect<A>>, so consumers must flatten (Effect.cached documented
 * signature in effect 3.22). */
const getGit = Effect.flatten(
    Effect.cached(Effect.promise(() => /** @type {Promise<any>} */ (import("isomorphic-git")))),
);

/** Warn only once per session about a broken .git/index. */
const warnedIndexRef = Effect.runSync(Ref.make(false));

/**
 * Directories excluded from the status matrix walk (same idea as the tree
 * scan: node_modules would mean thousands of FS round-trips for files that
 * are never tracked anyway).
 */
const STATUS_IGNORED_TOP = new Set(["node_modules", ".git", "dist", "build", "test-results", ".next", ".cache"]);

// ---------------------------------------------------------------------------
// Effect implementations
// ---------------------------------------------------------------------------

/**
 * Walk up from the current working directory to the nearest ancestor that
 * contains a `.git` directory (mirrors findRepoRoot in commands/git.mjs).
 * @param {WebFileSystem} fs
 * @returns {Effect.Effect<string, GitError, never>}
 */
function findRepoRootEffect(fs) {
    return Effect.gen(function* () {
        let dir = fs.cwd;
        while (true) {
            if (yield* existsEffect(fs, `${dir}/.git`)) return dir;
            if (dir === "/") return fs.cwd;
            dir = ("/" + dir.split("/").filter(Boolean).slice(0, -1).join("/")).replace(/\/+$/, "") || "/";
        }
    });
}

/**
 * @param {WebFileSystem} fs
 * @param {string} path
 * @returns {Effect.Effect<boolean, GitError, never>}
 */
function existsEffect(fs, path) {
    return Effect.tryPromise({
        try: () => fs.exists(path),
        catch: (cause) => GitError({ operation: "exists", path, cause }),
    });
}

/**
 * Compute @pierre/trees GitStatusEntry[] for the whole workspace.
 * Returns [] when there is no repo or the working tree is clean.
 * @param {WebFileSystem} fs
 * @returns {Effect.Effect<GitStatusEntry[], GitStatusError, never>}
 */
const getGitStatusEntriesEffect = (fs) =>
    Effect.gen(function* () {
        const root = yield* findRepoRootEffect(fs);
        if (!(yield* existsEffect(fs, `${root}/.git`))) return [];

        const git = /** @type {any} */ (yield* getGit);
        const gitFs = makeGitFs(fs);

        // statusMatrix accepts a `filepaths` filter; pass top-level directories
        // (minus the heavy/ignored ones) so node_modules is never walked.
        // Top-level files are handled individually via git.status().
        /** @type {string[]} */
        const filepaths = [];
        /** @type {string[]} */
        const topFiles = [];
        const tops = yield* Effect.tryPromise({
            try: () => fs.readdir(fs.cwd, { types: true }),
            catch: (cause) => GitError({ operation: "readdir", path: fs.cwd, cause }),
        }).pipe(Effect.option);
        if (tops._tag === "Some") {
            for (const [name, kind] of tops.value) {
                if (kind === "directory") {
                    if (!STATUS_IGNORED_TOP.has(name)) filepaths.push(name);
                } else {
                    topFiles.push(name);
                }
            }
        } else {
            filepaths.push("."); // fall back to a full walk
        }
        if (filepaths.length === 0 && topFiles.length === 0) return [];

        // If the repo root is an ancestor of the workspace, matrix paths are
        // relative to the repo root and must be stripped down to workspace-relative.
        const relCwd = root === fs.cwd ? "" : fs.cwd.slice(root.length + 1).replace(/\/+$/, "");
        const toWorkspacePath = (/** @type {string} */ p) =>
            relCwd && p.startsWith(`${relCwd}/`) ? p.slice(relCwd.length + 1) : p;

        /** @type {GitStatusEntry[]} */
        const entries = [];

        if (filepaths.length > 0) {
            const matrix = yield* Effect.tryPromise({
                try: () => git.statusMatrix({ fs: gitFs, dir: root, filepaths }),
                catch: (cause) => GitError({ operation: "statusMatrix", cause }),
            }).pipe(Effect.option);
            if (matrix._tag === "Some") {
                for (const row of matrix.value) {
                    const status = labelToStatus(statusLabel(row));
                    if (status) entries.push({ path: toWorkspacePath(row[0]), status });
                }
            } else {
                // Known failure mode: a corrupted/concurrently-written .git/index
                // ("Invalid checksum in GitIndex buffer"). Badges just stay stale —
                // warn once per session instead of on every fs change burst.
                yield* Ref.modify(warnedIndexRef, (warned) => {
                    if (!warned) console.warn("git statusMatrix failed, git badges disabled for this session");
                    return [undefined, true];
                });
            }
        }

        for (const fp of topFiles) {
            // git.status returns "regular" | "absent" | "modified" | "added" |
            // "deleted" | "ignored" | "unmodified"…
            const s = yield* Effect.tryPromise({
                try: () => git.status({ fs: gitFs, dir: root, filepath: relCwd ? `${relCwd}/${fp}` : fp }),
                catch: (cause) => GitError({ operation: "status", path: fp, cause }),
            }).pipe(Effect.option);
            if (s._tag === "Some") {
                const status = mapGitStatus(s.value);
                if (status) entries.push({ path: fp, status });
            }
        }

        return entries;
    }).pipe(Effect.withSpan("git.status"), Effect.withLogSpan("git.status"));

/**
 * Read a file's HEAD version (empty string for untracked/new files).
 * @param {WebFileSystem} fs
 * @param {string} path workspace-root-relative path
 * @returns {Effect.Effect<string, GitStatusError, never>}
 */
const readHeadFileEffect = (fs, path) =>
    Effect.gen(function* () {
        const root = yield* findRepoRootEffect(fs);
        if (!(yield* existsEffect(fs, `${root}/.git`))) return "";

        const git = /** @type {any} */ (yield* getGit);
        const gitFs = makeGitFs(fs);

        // Translate the workspace-relative path into repo-root-relative for git.
        const relCwd = root === fs.cwd ? "" : fs.cwd.slice(root.length + 1).replace(/\/+$/, "");
        const repoPath = relCwd ? `${relCwd}/${path}` : path;

        // Not tracked in HEAD (new file) or no commits yet → "".
        const blob = yield* Effect.tryPromise({
            try: async () => {
                const oid = await git.resolveRef({ fs: gitFs, dir: root, ref: "HEAD" });
                return git.readBlob({ fs: gitFs, dir: root, oid, filepath: repoPath });
            },
            catch: (cause) => GitError({ operation: "readBlob", path, cause }),
        }).pipe(Effect.option);

        return blob._tag === "Some" ? new TextDecoder().decode(blob.value.blob) : "";
    }).pipe(Effect.withSpan("git.head"), Effect.withLogSpan("git.head"));

/**
 * Discard uncommitted changes to a single file: restore its workdir content
 * from the index/HEAD (isomorphic-git's `checkout -- <file>` equivalent).
 * Also restores files that were deleted in the workdir.
 * @param {WebFileSystem} fs
 * @param {string} path workspace-root-relative path
 * @returns {Effect.Effect<void, GitStatusError, never>}
 */
const discardFileChangesEffect = (fs, path) =>
    Effect.gen(function* () {
        const root = yield* findRepoRootEffect(fs);
        if (!(yield* existsEffect(fs, `${root}/.git`))) {
            return yield* Effect.fail(NoRepoError("discard"));
        }

        const git = /** @type {any} */ (yield* getGit);
        const gitFs = makeGitFs(fs);

        const relCwd = root === fs.cwd ? "" : fs.cwd.slice(root.length + 1).replace(/\/+$/, "");
        const repoPath = relCwd ? `${relCwd}/${path}` : path;

        // No ref = current branch; filepaths + force = overwrite the workdir
        // copy from HEAD (and recreate deleted files). Untracked files are NOT
        // in HEAD, so checkout throws NotFoundError — surface a clear message.
        yield* Effect.tryPromise({
            try: () => git.checkout({ fs: gitFs, dir: root, filepaths: [repoPath], force: true }),
            catch: (cause) => {
                const code = /** @type {any} */ (cause)?.code;
                if (code === "NotFoundError" || code === "PathNotFoundError") {
                    return GitError({
                        operation: "checkout",
                        path,
                        cause: new Error(`${path} is not tracked by git (nothing to discard)`),
                    });
                }
                return GitError({ operation: "checkout", path, cause });            },
        });
    }).pipe(Effect.withSpan("git.discard"), Effect.withLogSpan("git.discard"));

// ---------------------------------------------------------------------------
// Service Tag + Layer
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *     getGitStatusEntries: (fs: WebFileSystem) => Effect.Effect<GitStatusEntry[], GitStatusError, never>,
 *     readHeadFile: (fs: WebFileSystem, path: string) => Effect.Effect<string, GitStatusError, never>,
 *     discardFileChanges: (fs: WebFileSystem, path: string) => Effect.Effect<void, GitStatusError, never>,
 * }} GitStatusImpl
 */

/**
 * The git status service. `yield* GitStatus` from new code.
 * @type {Context.Tag<"GitStatus", GitStatusImpl>}
 */
export const GitStatus = Context.GenericTag("GitStatus");

export const GitStatusLive = Layer.succeed(GitStatus, /** @type {GitStatusImpl} */ ({
    getGitStatusEntries: getGitStatusEntriesEffect,
    readHeadFile: readHeadFileEffect,
    discardFileChanges: discardFileChangesEffect,
}));

// ---------------------------------------------------------------------------
// Legacy Promise exports — consumed by components/file-tree.mjs (badges,
// diff view, discard action). Thin runPromise wrappers over the service
// effects; each call runs on a fresh runtime (no shared logging layer needed).
// Rejections unwrap the typed error so legacy callers still see `.message`
// / `_tag` directly instead of an Effect FiberFailure wrapper.

/**
 * Run a typed-error effect for a legacy caller, rethrowing the raw typed
 * error on failure.
 * @template A
 * @param {Effect.Effect<A, any, never>} effect
 * @returns {Promise<A>}
 */
function runLegacy(effect) {
    return Effect.runPromiseExit(effect).then((exit) => {
        if (exit._tag === "Failure") {
            const cause = /** @type {any} */ (exit.cause);
            throw cause?.error ?? cause?.defect ?? new Error(String(cause?._tag ?? "git failure"));
        }
        return /** @type {A} */ (exit.value);
    });
}
// ---------------------------------------------------------------------------

/**
 * @param {WebFileSystem} fs
 * @returns {Promise<GitStatusEntry[]>}
 */
export function getGitStatusEntries(fs) {
    return runLegacy(getGitStatusEntriesEffect(fs));
}

/**
 * @param {WebFileSystem} fs
 * @param {string} path workspace-root-relative path
 * @returns {Promise<string>}
 */
export function readHeadFile(fs, path) {
    return runLegacy(readHeadFileEffect(fs, path));
}

/**
 * @param {WebFileSystem} fs
 * @param {string} path workspace-root-relative path
 * @returns {Promise<void>}
 */
export function discardFileChanges(fs, path) {
    return runLegacy(discardFileChangesEffect(fs, path));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Map a two-letter XY label (commands/git.mjs statusLabel) to the tree's
 * GitStatus union. The tree renders "A"/"M"/"D"/"U" badges and propagates
 * "contains changes" to ancestor directories itself.
 * @param {string | null} label
 * @returns {import("@pierre/trees").GitStatus | null}
 */
function labelToStatus(label) {
    if (!label) return null;
    if (label === "??") return "untracked";
    const [x, y] = label;
    if (x === "A" || y === "A") return "added";
    if (x === "D" || y === "D") return "deleted";
    if (x === "R" || y === "R") return "renamed";
    if (x === "M" || y === "M") return "modified";
    return null;
}

/**
 * Map isomorphic-git's file-status string to the tree's GitStatus union.
 * @param {string} s
 * @returns {import("@pierre/trees").GitStatus | null}
 */
function mapGitStatus(s) {
    switch (s) {
        case "added":
        case "*added":
            return "added";
        case "modified":
        case "*modified":
            return "modified";
        case "deleted":
        case "*deleted":
            return "deleted";
        case "untracked":
            return "untracked";
        case "ignored":
            return "ignored";
        default:
            return null; // unmodified / absent
    }
}
