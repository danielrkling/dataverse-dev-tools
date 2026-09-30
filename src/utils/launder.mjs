/**
 * Extension laundering for OneDrive-synced folders.
 *
 * OneDrive flags certain extensions (e.g. `.js`) as "unsupported file types"
 * and shows sync errors. Files still get written, but the noise is annoying.
 *
 * To avoid this, JS files may be written with a laundered extension by
 * appending a suffix: `foo.js` -> `foo.js.$$.mjs`. The suffix is chosen so
 * the file still resolves as an ES module (`.mjs`) and is trivially
 * recognizable. The esbuild filesystem plugin falls back to the laundered
 * name when the plain name is not found.
 */

/** Suffix appended to laundered file paths. */
export const LAUNDER_SUFFIX = ".$$.mjs";

/**
 * Whether a path points to a laundered file.
 * @param {string} path
 * @returns {boolean}
 */
export function isLaundered(path) {
  return path.endsWith(LAUNDER_SUFFIX);
}

/**
 * Whether this filename is a candidate for laundering (only `.js` files,
 * which OneDrive blocks).
 * @param {string} path
 * @returns {boolean}
 */
export function shouldLaunder(path) {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return false; // no extension, or dotfile like `.gitignore`
  return last.slice(dot) === ".js";
}

/**
 * Un-launder every segment of a path pointing at a real on-disk location
 * (e.g. watch-event paths), so consumers see logical `.js` spellings.
 * @param {string} path
 * @returns {string}
 */
export function unsplicePath(path) {
  if (!path.includes("/")) return unlaunderPath(path);
  const parts = path.split("/");
  const last = parts.pop();
  parts.push(unlaunderPath(/** @type {string} */ (last)));
  return parts.join("/");
}

/**
 * Return the laundered variant of a path, or the path unchanged if it is
 * not a laundering candidate (e.g. already laundered).
 * @param {string} path
 * @returns {string}
 */
export function launderPath(path) {
  if (isLaundered(path) || !shouldLaunder(path)) return path;
  return path + LAUNDER_SUFFIX;
}

/**
 * Return the plain (un-laundered) variant of a laundered path,
 * or the path unchanged.
 * @param {string} path
 * @returns {string}
 */
export function unlaunderPath(path) {
  return isLaundered(path) ? path.slice(0, -LAUNDER_SUFFIX.length) : path;
}
