/** Directories never included in project scans. */
export const SCAN_IGNORED = [".git"];

/**
 * Recursively collect every path under the workspace root.
 *
 * Contract notes:
 * - All fs calls resolve from the workspace ROOT ("/abs"), never the
 *   terminal's current working directory.
 * - Returned paths are clean (no trailing slash); `dirs` classifies them.
 * - Callers feeding @pierre/trees must append "/" to directory paths —
 *   that library identifies directories ONLY by a trailing slash.
 *
 * Guarantees: no duplicates, parents listed before children, and every
 * entry is classified (dir vs file) via stat() BEFORE being added.
 *
 * @param {import("../services/fs.mjs").WebFileSystem} fs
 * @param {{ ignore?: string[] }} [options]
 * @returns {Promise<{paths: string[], dirs: Set<string>}>}
 */
export async function scanPaths(fs, options = {}) {
    const ignore = options.ignore ?? SCAN_IGNORED;
    /** @type {string[]} */
    const paths = [];
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {Set<string>} */
    const dirs = new Set();

    /**
     * @param {string} dirPath
     */
    async function walk(dirPath) {
        let names;
        try {
            names = await fs.readdir(dirPath || "/");
        } catch {
            return;
        }
        names.sort(); // codepoint order — matches @pierre/trees' comparator

        for (const name of names) {
            if (ignore.includes(name)) continue;
            const path = dirPath ? `${dirPath}/${name}` : name;
            if (seen.has(path)) continue;

            // Resolve from the workspace root, not the terminal cwd.
            let isDirectory;
            try {
                isDirectory = (await fs.stat(`/${path}`)).isDirectory;
            } catch {
                continue; // unreadable/racing entry — leave it out entirely
            }

            seen.add(path);

            if (isDirectory) {
                dirs.add(path);
                paths.push(`${path}/`);
                await walk(path);
            } else {
                paths.push(path);
            }
        }
    }

    await walk("");
    return { paths, dirs };
}

/**
 * Read a file from the workspace ROOT regardless of terminal cwd.
 * @param {import("../services/fs.mjs").WebFileSystem} fs
 * @param {string} path clean relative path
 * @param {string} [encoding]
 */
export function readRootFile(fs, path, encoding = "utf8") {
    return fs.readFile(`/${path}`, /** @type {any} */ (encoding));
}
