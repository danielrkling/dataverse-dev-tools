/**
 * Given a path, return a watchable directory.
 * If it's a file, returns its parent directory.
 * Returns null if the path doesn't exist.
 * @param {import('./fs.mjs').WebFileSystem} fs
 * @param {string} path
 * @returns {Promise<string|null>}
 */
export async function watchDir(fs, path) {
  try {
    const stat = await fs.stat(path);
    if (stat.isDirectory) return path;
    const parts = path.split('/');
    parts.pop();
    return parts.join('/') || '.';
  } catch {
    return null;
  }
}

/**
 * Read all content files and return their concatenated contents.
 * Each entry can be a file (read directly) or directory (recursively scanned).
 * @param {import('./fs.mjs').WebFileSystem} fs
 * @param {string[]} entries
 * @param {string[]|null} [extensions] Optional — only include files with these extensions
 * @returns {Promise<string>}
 */
export async function collectContent(fs, entries, extensions) {
  let allContent = '';

  for (const entry of entries) {
    let files;
    try {
      files = await fs.getFilesFromDirectory(entry);
    } catch {
      continue;
    }

    for (const [filePath, content] of Object.entries(files)) {
      if (extensions && extensions.length > 0) {
        const dot = filePath.lastIndexOf('.');
        if (dot === -1) continue;
        if (!extensions.includes(filePath.slice(dot + 1))) continue;
      }
      allContent += '\n' + content;
    }
  }

  return allContent;
}
