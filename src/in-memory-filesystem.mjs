export class WebFSError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class Node {
  constructor(type, name, parent = null) {
    this.type = type;
    this.name = name;
    this.parent = parent;
    this.children = type === "directory" ? new Map() : null;
    this.content = type === "file" ? new Uint8Array(0) : null;
    this.mtimeMs = Date.now();
  }
}

export class InMemoryFileSystem {
  constructor() {
    this.rootName = "mock-workspace";
    this.cwd = "/";
    this.root = new Node("directory", "");

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

  _resolvePath(path) {
    if (path.startsWith("/")) {
      return path;
    }
    const cwdParts = this.cwd.split("/").filter(Boolean);
    const targetParts = path.split("/").filter(Boolean);
    for (const part of targetParts) {
      if (part === ".") continue;
      if (part === "..") cwdParts.pop();
      else cwdParts.push(part);
    }
    return "/" + cwdParts.join("/");
  }

  _getNode(absPath) {
    const parts = absPath.split("/").filter(Boolean);
    let node = this.root;
    for (const part of parts) {
      if (!node.children || !node.children.has(part)) {
        const err = new WebFSError(`No such file or directory: ${absPath}`, "ENOENT");
        throw err;
      }
      node = node.children.get(part);
    }
    return node;
  }

  _getParent(absPath) {
    const parts = absPath.split("/").filter(Boolean);
    const name = parts.pop();
    let node = this.root;
    for (const part of parts) {
      if (!node.children || !node.children.has(part)) {
        const err = new WebFSError(`No such file or directory: ${absPath}`, "ENOENT");
        throw err;
      }
      node = node.children.get(part);
      if (node.type !== "directory") {
        throw new WebFSError(`Not a directory: ${absPath}`, "ENOTDIR");
      }
    }
    return { parent: node, name };
  }

  async access(path, mode) {
    this._getNode(this._resolvePath(path));
  }

  async appendFile(path, data, options) {
    const absPath = this._resolvePath(path);
    const node = this._getNode(absPath);
    if (node.type !== "file") throw new WebFSError(`Not a file: ${absPath}`, "EISDIR");
    const append = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    const merged = new Uint8Array(node.content.length + append.length);
    merged.set(node.content);
    merged.set(append, node.content.length);
    node.content = merged;
    node.mtimeMs = Date.now();
  }

  async chmod(path, mode) {
    // no-op
  }

  async chown(path, uid, gid) {
    // no-op
  }

  async copy(src, dest, options) {
    const data = await this.readFile(src);
    await this.writeFile(dest, data);
  }

  async copyFile(src, dest, mode) {
    await this.copy(src, dest);
  }

  async cp(src, dest, options) {
    await this.copy(src, dest);
  }

  async exists(path) {
    try {
      this._getNode(this._resolvePath(path));
      return true;
    } catch {
      return false;
    }
  }

  async glob(pattern, options) {
    throw new Error("Not Implemented");
  }

  async lchown(path, uid, gid) {
    // no-op
  }

  async lutimes(path, atime, mtime) {
    const node = this._getNode(this._resolvePath(path));
    node.mtimeMs = new Date(mtime).getTime();
  }

  async link(existingPath, newPath) {
    throw new Error("Not Implemented");
  }

  async lstat(path, options) {
    return this.stat(path);
  }

  async mkdir(path, options = {}) {
    const absPath = this._resolvePath(path);
    const { parent, name } = this._getParent(absPath);
    if (!parent.children.has(name)) {
      parent.children.set(name, new Node("directory", name, parent));
    } else {
      const node = parent.children.get(name);
      if (node.type !== "directory") {
        throw new WebFSError(`Not a directory: ${absPath}`, "ENOTDIR");
      }
    }
  }

  async mkdtemp(prefix, options) {
    const name = prefix + Math.random().toString(36).slice(2);
    await this.mkdir(name);
    return name;
  }

  async mkdtempDisposable(prefix, options) {
    return this.mkdtemp(prefix, options);
  }

  async open(path, flags, mode) {
    throw new Error("Not Implemented");
  }

  async opendir(path, flags, mode) {
    throw new Error("Not Implemented");
  }

  async readdir(path = ".") {
    const absPath = this._resolvePath(path);
    const node = this._getNode(absPath);
    if (node.type !== "directory") {
      throw new WebFSError(`Not a directory: ${absPath}`, "ENOTDIR");
    }
    return Array.from(node.children.keys());
  }

  async readFile(path, options = {}) {
    const absPath = this._resolvePath(path);
    const node = this._getNode(absPath);
    if (node.type !== "file") {
      throw new WebFSError(`Not a file: ${absPath}`, "EISDIR");
    }
    const encoding = (typeof options === "object" && options?.encoding) || (typeof options === "string" ? options : null);
    if (encoding === "utf8" || encoding === "utf-8") {
      return new TextDecoder().decode(node.content);
    }
    return node.content;
  }

  async readlink(path, options) {
    throw new Error("Not Implemented");
  }

  async realpath(path, options) {
    return this._resolvePath(path);
  }

  async rename(oldPath, newPath) {
    const absOld = this._resolvePath(oldPath);
    const absNew = this._resolvePath(newPath);
    const { parent: oldParent, name: oldName } = this._getParent(absOld);
    const node = oldParent.children.get(oldName);
    if (!node) throw new WebFSError(`No such file or directory: ${absOld}`, "ENOENT");

    const { parent: newParent, name: newName } = this._getParent(absNew);
    newParent.children.set(newName, node);
    node.name = newName;
    node.parent = newParent;
    oldParent.children.delete(oldName);
  }

  async rmdir(path, options = {}) {
    const absPath = this._resolvePath(path);
    if (absPath === "/") throw new Error("Cannot remove the root directory.");
    const { parent, name } = this._getParent(absPath);
    const node = parent.children.get(name);
    if (!node) throw new WebFSError(`No such file or directory: ${absPath}`, "ENOENT");
    if (node.type !== "directory") throw new WebFSError(`Not a directory: ${absPath}`, "ENOTDIR");
    if (node.children.size > 0 && !options.recursive) {
      throw new WebFSError(`Directory not empty: ${absPath}`, "ENOTEMPTY");
    }
    parent.children.delete(name);
  }

  async rm(path, options = {}) {
    const absPath = this._resolvePath(path);
    const { parent, name } = this._getParent(absPath);
    const node = parent.children.get(name);
    if (!node) throw new WebFSError(`No such file or directory: ${absPath}`, "ENOENT");
    if (node.type === "directory" && node.children.size > 0 && !options.recursive) {
      throw new WebFSError(`Directory not empty: ${absPath}`, "ENOTEMPTY");
    }
    parent.children.delete(name);
  }

  async stat(path) {
    const absPath = this._resolvePath(path);
    if (absPath === "/") {
      return {
        type: "directory",
        size: 0,
        mtimeMs: 0,
        isFile: false,
        isDirectory: true,
      };
    }
    const node = this._getNode(absPath);
    return {
      type: node.type,
      size: node.type === "file" ? node.content.length : 0,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.mtimeMs,
      isFile: node.type === "file",
      isDirectory: node.type === "directory",
      isSymbolicLink: false,
    };
  }

  async statfs(path, options) {
    throw new Error("Not Implemented");
  }

  async symlink(target, path, type) {
    throw new Error("Not Implemented");
  }

  async truncate(path, len) {
    const absPath = this._resolvePath(path);
    const node = this._getNode(absPath);
    if (node.type !== "file") throw new WebFSError(`Not a file: ${absPath}`, "EISDIR");
    const newContent = new Uint8Array(len);
    newContent.set(node.content.slice(0, len));
    node.content = newContent;
    node.mtimeMs = Date.now();
  }

  async unlink(path) {
    const absPath = this._resolvePath(path);
    if (absPath === "/") throw new Error("Cannot unlink the root directory.");
    const { parent, name } = this._getParent(absPath);
    const node = parent.children.get(name);
    if (!node) throw new WebFSError(`No such file or directory: ${absPath}`, "ENOENT");
    if (node.type !== "file") throw new WebFSError(`Is a directory: ${absPath}`, "EISDIR");
    parent.children.delete(name);
  }

  async utimes(path, atime, mtime) {
    const node = this._getNode(this._resolvePath(path));
    node.mtimeMs = new Date(mtime).getTime();
  }

  async watch(filename, options, callback) {
    throw new Error("Not Implemented");
  }

  async writeFile(path, data, options = {}) {
    const absPath = this._resolvePath(path);
    const { parent, name } = this._getParent(absPath);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    if (parent.children.has(name)) {
      const node = parent.children.get(name);
      if (node.type !== "file") throw new WebFSError(`Is a directory: ${absPath}`, "EISDIR");
      node.content = bytes;
      node.mtimeMs = Date.now();
    } else {
      const node = new Node("file", name, parent);
      node.content = bytes;
      parent.children.set(name, node);
    }
  }

  async cd(path) {
    const newCwd = this._resolvePath(path);
    if (newCwd === "/") {
      this.cwd = newCwd;
      return newCwd;
    }
    const node = this._getNode(newCwd);
    if (node.type !== "directory") {
      throw new WebFSError(`Not a directory: ${newCwd}`, "ENOTDIR");
    }
    this.cwd = newCwd;
    return newCwd;
  }

  async getFilesFromDirectory(path) {
    const absPath = this._resolvePath(path);
    const node = this._getNode(absPath);
    if (node.type !== "directory") {
      throw new WebFSError(`Not a directory: ${absPath}`, "ENOTDIR");
    }
    const files = {};
    const walk = (current, prefix) => {
      for (const [name, child] of current.children) {
        const key = prefix ? `${prefix}/${name}` : name;
        if (child.type === "file") {
          files[key] = new TextDecoder().decode(child.content);
        } else {
          walk(child, key);
        }
      }
    };
    walk(node, "");
    return files;
  }
}
