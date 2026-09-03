/**
 * Echo suppression for self-inflicted writes.
 *
 * Pipelines that write outputs back into the VFS (esbuild output files,
 * synced external changes) cause their own `fs:changed` events, which
 * would re-trigger the very pipeline that did the writing. Writes recorded
 * here are ignored by watch pipelines for a short window.
 */

/** @type {Map<string, number>} path -> expiry timestamp */
const echoes = new Map();

const WINDOW_MS = 1000;

/**
 * Record a self-inflicted write so watch pipelines ignore it briefly.
 * @param {string} path
 */
export function recordWrite(path) {
    echoes.set(path, Date.now() + WINDOW_MS);
}

/**
 * Record multiple self-inflicted writes.
 * @param {string[]} paths
 */
export function recordWrites(paths) {
    for (const p of paths) recordWrite(p);
}

/**
 * @param {string} path
 * @returns {boolean} true if this event should be suppressed as an echo
 */
export function isEcho(path) {
    const expiry = echoes.get(path);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
        echoes.delete(path);
        return false;
    }
    return true;
}

/** Periodic cleanup so the map cannot grow unboundedly. */
export function pruneEchoes() {
    const now = Date.now();
    for (const [path, expiry] of echoes) {
        if (now > expiry) echoes.delete(path);
    }
}
