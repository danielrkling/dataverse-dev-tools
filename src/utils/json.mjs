/**
 * @param {import('../fs.mjs').WebFileSystem} fs
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
