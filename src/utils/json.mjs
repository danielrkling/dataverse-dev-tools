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
