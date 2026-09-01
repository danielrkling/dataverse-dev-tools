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
        let entries;
        try {
            // readdir {types} returns [name, "file"|"directory"] in one call —
            // no stat() per entry (a stat round-trip per file made big
            // node_modules scans take minutes over the FS Access API).
            entries = await fs.readdir(dirPath || "/", { types: true });
        } catch {
            return;
        }
        entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // codepoint order — matches @pierre/trees' comparator

        for (const [name, kind] of entries) {
            if (ignore.includes(name)) continue;
            const path = dirPath ? `${dirPath}/${name}` : name;
            if (seen.has(path)) continue;

            const isDirectory = kind === "directory";
            if (kind !== "file" && !isDirectory) continue; // unreadable/racing entry

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
