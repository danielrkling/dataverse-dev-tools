/**
 * Neutral git/isomorphic-git helpers shared by the git command module and the
 * git-status service. Lives outside commands/ so that services/ never has to
 * import from commands/ (which would create an import cycle).
 *
 * - makeGitFs: wraps a WebFileSystem in the shape isomorphic-git expects
 *   (stat/lstat flag methods, `.promises` proxy, ENOENT normalization).
 * - statusLabel: renders a statusMatrix row as a two-letter XY git label.
 */

/**
 * @param {import('./fs.mjs').WebFileSystem} fs
 * @returns {any}
 */
export function makeGitFs(fs) {
  const methods = ['readFile', 'writeFile', 'unlink', 'readdir', 'mkdir', 'rmdir', 'stat', 'lstat', 'rename'];
  /** @type {any} */
  const wrapped = {};
  for (const m of methods) {
    const orig = /** @type {any} */ (fs)[m];
    /** @type {(...args: any[]) => Promise<any>} */
    const wrapper = async (...args) => {
      try {
        const result = await orig.apply(fs, args);
        if (m === 'stat' || m === 'lstat') {
          return { ...result, isDirectory: () => result.isDirectory, isFile: () => result.isFile, isSymbolicLink: () => result.isSymbolicLink };
        }
        return result;
      } catch (e) {
        throw normalizeFsError(e);
      }
    };
    wrapped[m] = wrapper;
  }
  wrapped.readlink = async () => { throw Object.assign(new Error('no such symlink'), { code: 'ENOENT' }); };
  wrapped.symlink = async () => {};
  wrapped.chmod = async () => {};
  wrapped.promises = new Proxy(wrapped, {
    get(target, prop) {
      if (prop === 'readlink') return wrapped.readlink;
      if (prop === 'symlink') return wrapped.symlink;
      if (prop === 'chmod') return wrapped.chmod;
      return target[/** @type {string} */ (prop)];
    },
  });
  return wrapped;
}

/**
 * isomorphic-git expects ENOENT-coded errors to detect missing files/repos,
 * but the File System Access API throws DOMExceptions with different names.
 * @param {any} e
 * @returns {Error}
 */
function normalizeFsError(e) {
  if (!e || typeof e !== 'object') return e;
  if (e.code) return e;
  const name = e.name || '';
  if (name === 'NotFoundError' || name === 'TypeMismatchError') {
    return Object.assign(new Error(`No such file or directory`), { code: 'ENOENT', cause: e });
  }
  return e;
}

/**
 * Computes a two-letter git-style XY status label from a statusMatrix row
 * [filepath, head, workdir, stage]. Values are 0 (absent), 1 (unchanged)
 * and 2/3 (modified / added).
 * @param {[string, number, number, number]} row
 * @returns {string | null} e.g. "M ", " M", "A ", "??", "D " — null when clean
 */
export function statusLabel([, head, workdir, stage]) {
  // Untracked: not in HEAD, present in workdir, not staged.
  if (head === 0 && stage === 0 && workdir !== 0) return '??';

  let x = ' '; // index vs HEAD
  let y = ' '; // workdir vs index

  if (stage !== head) {
    if (head === 0) x = 'A';
    else if (stage === 0) x = 'D';
    else x = 'M';
  }
  if (workdir !== stage) {
    if (stage === 0) y = 'A';
    else if (workdir === 0) y = 'D';
    else y = 'M';
  }
  if (x === ' ' && y === ' ') return null;
  return `${x}${y}`;
}
