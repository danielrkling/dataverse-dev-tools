import { makeGitFs, statusLabel } from "../commands/git.mjs";

/**
 * Git status + HEAD content helpers shared by the file tree (badges) and the
 * editor pane (Monaco diff view).
 *
 * All paths flowing through here are workspace-root-relative, matching the
 * tree's canonical paths. isomorphic-git is loaded lazily (dynamic import)
 * so nothing pays for it until a repo is actually present.
 */

/** @type {Promise<any> | null} */
let gitPromise = null;

/** Warn only once per session about a broken .git/index. */
let warnedIndexError = false;

/** @returns {Promise<any>} */
function getGit() {
    gitPromise ??= import("isomorphic-git");
    return gitPromise;
}

/**
 * Directories excluded from the status matrix walk (same idea as the tree
 * scan: node_modules would mean thousands of FS round-trips for files that
 * are never tracked anyway).
 */
const STATUS_IGNORED_TOP = new Set(["node_modules", ".git", "dist", "build", "test-results", ".next", ".cache"]);

/**
 * Walk up from the current working directory to the nearest ancestor that
 * contains a `.git` directory (mirrors findRepoRoot in commands/git.mjs).
 * @param {import("./fs.mjs").WebFileSystem} fs
 * @returns {Promise<string>} absolute repo root (falls back to fs.cwd)
 */
async function findRepoRoot(fs) {
    let dir = fs.cwd;
    while (true) {
        if (await fs.exists(`${dir}/.git`)) return dir;
        if (dir === "/") return fs.cwd;
        dir = ("/" + dir.split("/").filter(Boolean).slice(0, -1).join("/")).replace(/\/+$/, "") || "/";
    }
}

/**
 * Compute @pierre/trees GitStatusEntry[] for the whole workspace.
 * Returns [] when there is no repo or the working tree is clean.
 * @param {import("./fs.mjs").WebFileSystem} fs
 * @returns {Promise<import("@pierre/trees").GitStatusEntry[]>}
 */
export async function getGitStatusEntries(fs) {
    const root = await findRepoRoot(fs);
    if (!(await fs.exists(`${root}/.git`))) return [];

    const git = await getGit();
    const gitFs = makeGitFs(fs);

    // statusMatrix accepts a `filepaths` filter; pass top-level directories
    // (minus the heavy/ignored ones) so node_modules is never walked.
    // Top-level files are handled individually via git.status().
    /** @type {string[]} */
    const filepaths = [];
    /** @type {string[]} */
    const topFiles = [];
    try {
        const tops = await fs.readdir(fs.cwd, { types: true });
        for (const [name, kind] of tops) {
            if (kind === "directory") {
                if (!STATUS_IGNORED_TOP.has(name)) filepaths.push(name);
            } else {
                topFiles.push(name);
            }
        }
    } catch {
        filepaths.push("."); // fall back to a full walk
    }
    if (filepaths.length === 0 && topFiles.length === 0) return [];

    // If the repo root is an ancestor of the workspace, matrix paths are
    // relative to the repo root and must be stripped down to workspace-relative.
    const relCwd = root === fs.cwd ? "" : fs.cwd.slice(root.length + 1).replace(/\/+$/, "");
    const toWorkspacePath = (/** @type {string} */ p) => (relCwd && p.startsWith(`${relCwd}/`) ? p.slice(relCwd.length + 1) : p);

    /** @type {import("@pierre/trees").GitStatusEntry[]} */
    const entries = [];

    if (filepaths.length > 0) {
        try {
            const matrix = await git.statusMatrix({ fs: gitFs, dir: root, filepaths });
            for (const row of matrix) {
                const status = labelToStatus(statusLabel(row));
                if (status) entries.push({ path: toWorkspacePath(row[0]), status });
            }
        } catch (error) {
            // Known failure mode: a corrupted/concurrently-written .git/index
            // ("Invalid checksum in GitIndex buffer"). Badges just stay stale —
            // warn once per session instead of on every fs change burst.
            if (!warnedIndexError) {
                warnedIndexError = true;
                console.warn("git statusMatrix failed, git badges disabled for this session:", error.message);
            }
        }
    }

    for (const fp of topFiles) {
        try {
            // git.status returns "regular" | "absent" | "modified" | "added" | "deleted" | "ignored" | "unmodified"…
            const s = await git.status({ fs: gitFs, dir: root, filepath: relCwd ? `${relCwd}/${fp}` : fp });
            const status = mapGitStatus(s);
            if (status) entries.push({ path: fp, status });
        } catch {
            // not a repo, unreadable entry, etc. — skip
        }
    }

    return entries;
}

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

/**
 * Read a file's HEAD version (empty string for untracked/new files).
 * @param {import("./fs.mjs").WebFileSystem} fs
 * @param {string} path workspace-root-relative path
 * @returns {Promise<string>}
 */
export async function readHeadFile(fs, path) {
    const root = await findRepoRoot(fs);
    if (!(await fs.exists(`${root}/.git`))) return "";

    const git = await getGit();
    const gitFs = makeGitFs(fs);

    // Translate the workspace-relative path into repo-root-relative for git.
    const relCwd = root === fs.cwd ? "" : fs.cwd.slice(root.length + 1).replace(/\/+$/, "");
    const repoPath = relCwd ? `${relCwd}/${path}` : path;

    try {
        const oid = await git.resolveRef({ fs: gitFs, dir: root, ref: "HEAD" });
        const blob = await git.readBlob({ fs: gitFs, dir: root, oid, filepath: repoPath });
        return new TextDecoder().decode(blob.blob);
    } catch {
        return ""; // not tracked in HEAD (new file) or no commits yet
    }
}

/**
 * Discard uncommitted changes to a single file: restore its workdir content
 * from the index/HEAD (isomorphic-git's `checkout -- <file>` equivalent).
 * Also restores files that were deleted in the workdir.
 * @param {import("./fs.mjs").WebFileSystem} fs
 * @param {string} path workspace-root-relative path
 */
export async function discardFileChanges(fs, path) {
    const root = await findRepoRoot(fs);
    if (!(await fs.exists(`${root}/.git`))) {
        throw new Error("not a git repository");
    }

    const git = await getGit();
    const gitFs = makeGitFs(fs);

    const relCwd = root === fs.cwd ? "" : fs.cwd.slice(root.length + 1).replace(/\/+$/, "");
    const repoPath = relCwd ? `${relCwd}/${path}` : path;

    // No ref = current branch; filepaths + force = overwrite the workdir
    // copy from HEAD (and recreate deleted files). Untracked files are NOT
    // in HEAD, so checkout throws NotFoundError — surface a clear message.
    try {
        await git.checkout({ fs: gitFs, dir: root, filepaths: [repoPath], force: true });
    } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        if (code === "NotFoundError" || code === "PathNotFoundError") {
            throw new Error(`${path} is not tracked by git (nothing to discard)`);
        }
        throw error;
    }
}
