/** @type {string[]} */
export const EXTENSIONS = ['', '.ts', '.mts', '.tsx', '.js', '.jsx', '.mjs', '.json'];

/**
 * @param {string} path
 * @returns {string}
 */
export function dirname(path) {
  const i = path.lastIndexOf('/');
  if (i === -1) return '';
  return path.slice(0, i);
}

/**
 * @param {string} path
 * @returns {string}
 */
export function basename(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * @param {string} path
 * @returns {string}
 */
export function extname(path) {
  const i = path.lastIndexOf('.');
  if (i === -1) return '';
  if (path.lastIndexOf('/') > i) return '';
  return path.slice(i);
}

/**
 * @param {...string} parts
 * @returns {string}
 */
export function join(...parts) {
  return normalize(parts.join('/'));
}

/**
 * @param {string} path
 * @returns {string}
 */
export function normalize(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}
