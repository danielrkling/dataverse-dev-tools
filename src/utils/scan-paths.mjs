import { Effect } from "effect";

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
 * @param {import("../types/services.d.ts").WorkspaceFsService} fs
 * @param {{ ignore?: string[] }} [options]
 * @returns {Promise<{paths: string[], dirs: Set<string>}>}
 */
export function scanPaths(fs, options = {}) {
    return Effect.runPromise(scanPathsEffect(fs, options));
}

/**
 * Read a file from the workspace ROOT regardless of terminal cwd.
 * @param {import("../types/services.d.ts").WorkspaceFsService} fs
 * @param {string} path clean relative path
 * @param {string} [encoding]
 */
export function readRootFile(fs, path, encoding = "utf8") {
    return fs.readFile(`/${path}`, /** @type {any} */ (encoding));
}

// ---------------------------------------------------------------------------
// Effect-native variant
// ---------------------------------------------------------------------------

/** @typedef {{ _tag: "ScanReaddirError", path: string, cause: unknown }} ScanReaddirError */

/**
 * Factory for the typed readdir failure surfaced by {@link scanPathsEffect}.
 * The scan itself is tolerant of unreadable directories (they are skipped),
 * so this error type exists for callers that want to observe failures via
 * `Effect.tapErrorCause` / telemetry rather than the default skip.
 *
 * @param {{ path: string, cause: unknown }} props
 * @returns {ScanReaddirError}
 */
export const ScanReaddirError = (props) => ({
    _tag: /** @type {const} */ ("ScanReaddirError"),
    ...props,
});

/**
 * Effect version of {@link scanPaths}. Preserves ALL documented guarantees:
 * parents before children, directory entries emitted with a trailing "/",
 * ignore list, codepoint-order sort of each directory's entries, one
 * `readdir(dir, { types: true })` call per directory, and tolerance of
 * unreadable entries (skipped, not failed).
 *
 * Subdirectory recursion is `Effect.forEach`-based and concurrency-limited;
 * the default `concurrency: 1` yields byte-identical output to
 * {@link scanPaths} (a strict depth-first, sorted walk). Raise it only if
 * you accept interleaved-but-still-parents-first ordering across sibling
 * subtrees.
 *
 * @param {import("../types/services.d.ts").WorkspaceFsService} fs
 * @param {{ ignore?: string[], concurrency?: number }} [options]
 * @returns {Effect.Effect<{paths: string[], dirs: Set<string>}, ScanReaddirError, never>}
 */
export function scanPathsEffect(fs, options = {}) {
    const ignore = options.ignore ?? SCAN_IGNORED;
    const concurrency = options.concurrency ?? 1;

    return Effect.gen(function* () {
        /** @type {string[]} */
        const paths = [];
        /** @type {Set<string>} */
        const seen = new Set();
        /** @type {Set<string>} */
        const dirs = new Set();

        /**
         * @param {string} dirPath
         * @returns {Effect.Effect<void, ScanReaddirError, never>}
         */
        function walk(dirPath) {
            return Effect.gen(function* () {
                // readdir {types} returns [name, "file"|"directory"] in one
                // call — no stat() per entry (a stat round-trip per file made
                // big node_modules scans take minutes over the FS Access API).
                const entries = /** @type {[string, string][]} */ (yield* Effect.tryPromise({
                    try: () => fs.readdir(dirPath || "/", { types: true }),
                    catch: (cause) => ScanReaddirError({ path: dirPath, cause }),
                }).pipe(Effect.catchAll(() => Effect.succeed(/** @type {[string, string][]} */ ([])))));

                entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // codepoint order — matches @pierre/trees' comparator

                yield* Effect.forEach(
                    entries,
                    /**
                     * @param {[string, string]} entry
                     */
                    ([name, kind]) =>
                        Effect.gen(function* () {
                            if (ignore.includes(name)) return;
                            const path = dirPath ? `${dirPath}/${name}` : name;
                            if (seen.has(path)) return;

                            const isDirectory = kind === "directory";
                            if (kind !== "file" && !isDirectory) return; // unreadable/racing entry

                            seen.add(path);

                            if (isDirectory) {
                                dirs.add(path);
                                paths.push(`${path}/`);
                                yield* walk(path);
                            } else {
                                paths.push(path);
                            }
                        }),
                    { concurrency, discard: true },
                );
            });
        }

        yield* walk("");
        return { paths, dirs };
    });
}
