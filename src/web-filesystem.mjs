export class WebFSError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * A file system adapter class that mirrors the lightning-fs API
 * and is implemented using the native File System Access API.
 */
export class WebFileSystem {
  /**
   * @param {FileSystemDirectoryHandle} rootHandle The root directory for all file system operations.
   */
  constructor(rootHandle) {
    if (!rootHandle || rootHandle.kind !== "directory") {
      throw new Error(
        "A valid FileSystemDirectoryHandle must be provided as the root.",
      );
    }
    this.rootHandle = rootHandle;
    this.rootName = rootHandle.name; // Stores the name of the root directory for display
    this.cwd = "/"; // Current Working Directory, initialized to root

    this.promises = {
      mkdir: this.mkdir.bind(this),
      rmdir: this.rmdir.bind(this),
      readdir: this.readdir.bind(this),
      writeFile: this.writeFile.bind(this),
      readFile: this.readFile.bind(this),
      unlink: this.unlink.bind(this),
      rename: this.rename.bind(this),
      stat: this.stat.bind(this),
      lstat: this.lstat.bind(this),
      symlink: this.symlink.bind(this),
      readlink: this.readlink.bind(this),
      chmod: this.chmod.bind(this),
    };
  }

  /**
   * Resolves a relative path (or absolute path) to an absolute path within the file system.
   * Handles '.', '..', and concatenates with the current working directory.
   * @private
   * @param {string} path The path to resolve.
   * @returns {string} The resolved absolute path.
   */
  _resolvePath(path) {
    if (path.startsWith("/")) {
      return path; // Already an absolute path
    }

    const cwdParts = this.cwd.split("/").filter(Boolean);
    const targetParts = path.split("/").filter(Boolean);

    for (const part of targetParts) {
      if (part === ".") {
        continue;
      }
      if (part === "..") {
        cwdParts.pop(); // Go up one level
      } else {
        cwdParts.push(part); // Go down into a directory/file
      }
    }
    return "/" + cwdParts.join("/");
  }

  /**
   * Helper to get the parent directory handle and the entry name for mutations.
   * @private
   * @param {string} absPath The absolute path of the entry to mutate.
   * @returns {Promise<{parentDir: FileSystemDirectoryHandle, name: string}>}
   * @throws {Error} If the path is invalid or leads to the root.
   */
  async _resolvePathForMutation(absPath) {
    const parts = absPath.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error("Cannot perform mutation on root directory.");

    let parentDir = this.rootHandle;
    for (const part of parts) {
      parentDir = await parentDir.getDirectoryHandle(part);
    }
    return { parentDir, name };
  }

  /**
   * Helper to get a FileSystemHandle (file or directory) from an absolute path string.
   * Traverses the directory structure from the rootHandle.
   * @private
   * @param {string} absPath The absolute path to the file or directory.
   * @returns {Promise<FileSystemFileHandle|FileSystemDirectoryHandle>} The handle for the given path.
   * @throws {Error} If the path does not exist or refers to an incorrect type.
   */
  async _getHandle(absPath) {
    let handle = this.rootHandle;
    const parts = absPath.split("/").filter(Boolean); // Split path into components

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      try {
        // Try to get a directory handle first
        handle = await handle.getDirectoryHandle(part);
      } catch (e) {
        // If it's not a directory, it might be a file
        if (e.name === "TypeMismatchError" || i === parts.length - 1) {
          // If it's the last part and not a directory, try to get a file handle
          handle = await handle.getFileHandle(part);
          // If it's a file, we stop traversing. The remaining parts are invalid.
          if (handle.kind === "file" && i < parts.length - 1) {
            throw new WebFSError(`Not a directory: ${absPath}`, "ENOTDIR");
          }
          break;
        }
        throw new WebFSError(`No such file or directory: ${absPath}`, "ENOENT");
      }
    }
    return handle;
  }

  async access(path, mode) {
    throw new Error("Not Implemented");
  }

  async appendFile(path, data, options) {
    throw new Error("Not Implemented");
  }

  async chmod(path, mode) {
    throw new Error("Not Implemented");
  }

  async chown(path, uid, gid) {
    throw new Error("Not Implemented");
  }

  async copy(src,dest,options){
    
  }

  async copyFile(src, dest, mode) {
    throw new Error("Not Implemented");
  }

  async cp(src, dest, options) {
    throw new Error("Not Implemented");
  }

  async exists(path) {
    try {
      this._getHandle(this._resolvePath(path));
    } catch {
      return false;
    }
  }

  async glob(pattern, options) {
    throw new Error("Not Implemented");
  }

  async lchown(path, uid, gid) {
    throw new Error("Not Implemented");
  }

  async lutimes(path, atime, mtime) {
    throw new Error("Not Implemented");
  }

  async link(existingPath, newPath) {
    throw new Error("Not Implemented");
  }

  /**
   * Gets file or directory status information, identical to stat as
   * File System Access API does not expose symbolic links.
   * @param {string} path The path to query.
   * @returns {Promise<object>}
   */
  lstat(path, options) {
    return this.stat(path);
  }

  /**
   * Creates a directory.
   * @param {string} path The path of the directory to create.
   * @param {object} [options] Options for creating the directory.
   * @param {boolean} [options.recursive=false] If true, creates parent directories if they don't exist.
   * @returns {Promise<void>}
   */
  async mkdir(path, options = {}) {
    const absPath = this._resolvePath(path);
    const parts = absPath.split("/").filter(Boolean);
    let currentDir = this.rootHandle;

    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create: true });
    }
  }

  async mkdtemp(prefix, options) {
    throw new Error("Not Implemented");
  }

  async mkdtempDisposable(prefix, options) {
    throw new Error("Not Implemented");
  }

  async open(path, flags, mode) {
    throw new Error("Not Implemented");
  }

  async opendir(path, flags, mode) {
    throw new Error("Not Implemented");
  }

  /**
   * Reads the contents of a directory.
   * @param {string} [path=''] The path of the directory to read (defaults to CWD).
   * @returns {Promise<string[]>} An array of names of the entries in the directory.
   * @throws {Error} If the path is not a directory or does not exist.
   */
  async readdir(path = ".") {
    const absPath = this._resolvePath(path);
    const dirHandle = await this._getHandle(absPath);

    if (dirHandle.kind !== "directory") {
      throw new WebFSError(`Not a directory: ${absPath}`, "ENOTDIR");
    }

    const files = [];
    for await (const entry of dirHandle.values()) {
      files.push(entry.name);
    }
    return files;
  }

  /**
   * Reads the content of a file.
   * @param {string} path The path of the file to read.
   * @param {object} [options] Options for reading the file (e.g., encoding: 'utf8').
   * @returns {Promise<string|Uint8Array>} The file content as a string (if encoding specified) or Uint8Array.
   * @throws {Error} If the path is not a file or does not exist.
   */
  async readFile(path, options = {}) {
    const absPath = this._resolvePath(path);
    try {
      const fileHandle = await this._getHandle(absPath);
      if (fileHandle.kind !== "file") {
        throw new WebFSError(`Not a file: ${absPath}`, "EISDIR");
      }
      const file = await fileHandle.getFile();
      const encoding =
        (typeof options === "object" && options?.encoding) ||
        (typeof options === "string" ? options : null);
      if (encoding === "utf8" || encoding === "utf-8") {
        return await file.text();
      }
      return await file.arrayBuffer();
      // const arrayBuffer = await file.arrayBuffer();
      // return Buffer.from(arrayBuffer); // Requires Buffer polyfill
    } catch (e) {
      if (e.code === "ENOENT") {
        e.message = `No such file: ${absPath}`;
      }
      throw e;
    }
  }

  async readlink(path, options) {
    throw new Error("Not Implemented");
  }

  async realpath(path, options) {
    throw new Error("Not Implemented");
  }

  /**
   * Renames a file or directory. Note: This is a copy-then-delete operation
   * as the File System Access API does not directly support renames.
   * @param {string} oldPath The current path.
   * @param {string} newPath The new path.
   * @returns {Promise<void>}
   */
  async rename(oldPath, newPath) {
    const absOldPath = this._resolvePath(oldPath);
    const absNewPath = this._resolvePath(newPath);

    const oldHandle = await this._getHandle(absOldPath);

    if (oldHandle.kind === "file") {
      const content = await this.readFile(absOldPath);
      await this.writeFile(absNewPath, content);
      await this.unlink(absOldPath);
    } else if (oldHandle.kind === "directory") {
      // Renaming directories is complex with File System Access API
      // as it requires recursively copying contents. For simplicity,
      // this implementation only handles files for now.
      throw new Error(
        "Renaming directories is not fully supported yet in this adapter.",
      );
    }
  }

  /**
   * Removes a directory.
   * @param {string} path The path of the directory to remove.
   * @param {object} [options] Options for removing the directory.
   * @param {boolean} [options.recursive=false] If true, allows removing non-empty directories.
   * @returns {Promise<void>}
   */
  async rmdir(path, options = {}) {
    const absPath = this._resolvePath(path);
    if (absPath === "/") {
      throw new Error("Cannot remove the root directory.");
    }
    const { parentDir, name } = await this._resolvePathForMutation(absPath); // Helper to get parent and name
    await parentDir.removeEntry(name, {
      recursive: options.recursive || false,
    });
  }

  async rm(path, options) {
    throw new Error("Not Implemented");
  }

  /**
   * Gets file or directory status information.
   * @param {string} path The path to query.
   * @returns {Promise<{type: string, size: number, mtimeMs: number, isFile: Function, isDirectory: Function}>}
   * @throws {Error} If the path does not exist.
   */
  async stat(path) {
    const absPath = this._resolvePath(path);
    if (absPath === "/") {
      // Special case for the root directory
      return {
        type: "directory",
        size: 0, // Root size is not meaningful in this context
        mtimeMs: 0, // No specific last modified for root
        isFile: false,
        isDirectory: true,
      };
    }

    try {
      const handle = await this._getHandle(absPath);
      const type = handle.kind;

      const file = type === "file" ? await handle.getFile() : null;

      return {
        type, // 'file' or 'directory'
        size: file?.size ?? 0,
        mtimeMs: file?.lastModified ?? 0, // Last modified timestamp
        ctimeMs: file?.lastModified ?? 0, // Last modified timestamp
        isFile: type === "file",
        isDirectory: type === "directory",
        isSymbolicLink: false,
      };
    } catch (e) {
      throw new WebFSError(`No such file or directory: ${absPath}`, "ENOENT");
    }
  }

  async statfs(path, options) {
    throw new Error("Not Implemented");
  }

  async symlink(target, path, type) {
    throw new Error("Not Implemented");
  }

  async truncate(path, len) {
    throw new Error("Not Implemented");
  }

  /**
   * Removes a file.
   * @param {string} path The path of the file to remove.
   * @returns {Promise<void>}
   */
  async unlink(path) {
    const absPath = this._resolvePath(path);
    if (absPath === "/") {
      throw new Error("Cannot unlink the root directory.");
    }
    const { parentDir, name } = await this._resolvePathForMutation(absPath); // Helper to get parent and name
    await parentDir.removeEntry(name,{
      recursive:true
    });
  }

  async utimes(path, atime, mtime) {
    throw new Error("Not Implemented");
  }

  async watch(filename, options, callback) {
    const handle = await this._getHandle(filename);

    const watcher = new FileSystemObserver((records) => {
      for (const record of records) {
        const path = record.relativePathComponents.join("/");
        callback(record.type, path);
      }
    });

    watcher.observe(handle, options);
  }

  /**
   * Writes data to a file.
   * @param {string} path The path of the file to write to.
   * @param {string|ArrayBuffer|Blob|ArrayBufferView} data The data to write.
   * @param {object} [options] Options for writing the file (e.g., encoding).
   * @returns {Promise<void>}
   */
  async writeFile(path, data, options = {}) {
    const absPath = this._resolvePath(path);
    const parts = absPath.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error("Invalid file path.");

    let currentDir = this.rootHandle;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create: true });
    }

    const fileHandle = await currentDir.getFileHandle(fileName, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  /**
   * Changes the current working directory.
   * @param {string} path The path to change to (can be relative or absolute).
   * @returns {Promise<string>}
   * @throws {Error} If the path is not a directory or does not exist.
   */
  async cd(path) {
    const newCwd = this._resolvePath(path);

    // Root path is always valid and a directory
    if (newCwd === "/") {
      this.cwd = newCwd;
      return newCwd;
    }

    try {
      const handle = await this._getHandle(newCwd);
      if (handle.kind !== "directory") {
        throw new WebFSError(`Not a directory: ${absPath}`, "ENOTDIR");
      }
      this.cwd = newCwd; // Only change CWD on success
      return newCwd;
    } catch (e) {
      throw new WebFSError(`No such file or directory: ${absPath}`, "ENOENT");
    }
  }

  async getFilesFromDirectory(path) {
    const handle = await this._getHandle(this._resolvePath(path));
    const files = {};
    const tasks = [];

    /**
     *
     * @param {FileSystemDirectoryHandle} dirHandle
     * @param {string} currentPath
     */
    async function recursiveRead(dirHandle, currentPath) {
      for await (const entry of dirHandle.values()) {
        const newPath = currentPath
          ? `${currentPath}/${entry.name}`
          : entry.name;

        if (entry.kind === "file") {
          tasks.push(readFile(entry, newPath));
        } else if (entry.kind === "directory") {
          await recursiveRead(entry, newPath);
        }
      }
    }

    async function readFile(handle, path) {
      try {
        const file = await handle.getFile();
        const content = await file.text();
        files[path] = content;
      } catch (e) {
        console.error(`Could not read file: ${path}`, e);
      }
    }
    await recursiveRead(handle, "");
    await Promise.all(tasks);
    return files;
  }
}

