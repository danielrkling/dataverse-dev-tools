import { Effect } from "effect";

/**
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {string} path
 * @returns {Promise<any>}
 */
export async function readJSON(fs, path) {
  try {
    const raw = await fs.readFile(path, { encoding: 'utf8' });
    return JSON.parse(/** @type {string} */ (raw));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Effect variants (typed errors instead of the null-return contract above)
// ---------------------------------------------------------------------------

/** @typedef {{ _tag: "JsonReadError", path: string, cause: unknown }} JsonReadError */

/**
 * Factory for the typed failure of {@link readJSONEffect}. Covers both fs
 * read failures and JSON.parse failures (inspect `cause` to distinguish).
 *
 * @param {{ path: string, cause: unknown }} props
 * @returns {JsonReadError}
 */
export const JsonReadError = (props) => ({
  _tag: /** @type {const} */ ("JsonReadError"),
  ...props,
});

/**
 * Effect version of {@link readJSON} with typed errors: fails with
 * {@link JsonReadError} when the file cannot be read or parsed. To keep the
 * legacy "missing config = null" contract, use {@link readJSONOrNullEffect}.
 *
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {string} path
 * @returns {Effect.Effect<any, JsonReadError, never>}
 */
export function readJSONEffect(fs, path) {
  return Effect.tryPromise({
    try: async () => {
      const raw = await fs.readFile(path, { encoding: "utf8" });
      return JSON.parse(/** @type {string} */ (raw));
    },
    catch: (cause) => JsonReadError({ path, cause }),
  });
}

/**
 * Convenience sibling of {@link readJSONEffect} that mirrors the original
 * {@link readJSON} null-return contract: any read/parse failure yields
 * `null` instead of failing.
 *
 * @param {import('../services/fs.mjs').WebFileSystem} fs
 * @param {string} path
 * @returns {Effect.Effect<any, never, never>}
 */
export function readJSONOrNullEffect(fs, path) {
  return Effect.catchAll(readJSONEffect(fs, path), () => Effect.succeed(null));
}

/**
 * Removes properties from an object that have an explicit value of `undefined`.
 * Keeps other falsy values such as `null`, `false`, `0`, and `""`.
 *
 * @template {Record<string, any>} T
 * @param {T} obj - The source object to clean.
 * @returns {Omit<T, { [K in keyof T]: T[K] extends undefined ? K : never }[keyof T]>} A new object with all `undefined` properties removed.
 */
export function dropUndefined(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }

  //@ts-expect-error
  return Object.fromEntries(
    Object.entries(obj).filter(([_, value]) => value !== undefined)
  );
}
