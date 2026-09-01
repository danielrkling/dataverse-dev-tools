import { Workspace, errors } from "modern-monaco";
import { workspace } from "./workspace.mjs";
import { bus } from "./bus.mjs";

/**
 * Adapter that exposes the active workspace filesystem (services/workspace.mjs
 * -> WebFileSystem, a node-like FS over the File System Access API / OPFS) as
 * a modern-monaco `FileSystem` (see modern-monaco types/workspace.d.ts).
 *
 * Passing this to `init({ workspace })` gives the modern-monaco LSPs live
 * access to the whole project — the TypeScript worker receives a walked file
 * list at setup time and watches tsconfig.json / index.html through `watch`.
 * This replaces the old "hydrate every file into a Monaco model" strategy.
 *
 * The adapter is live: it always delegates to the CURRENTLY open workspace,
 * so the same modern-monaco Workspace instance survives opening a new folder
 * (the LSPs re-walk the FS when tsconfig.json/index.html change events arrive).
 */

const FILE = 1;
const DIR = 2;

/**
 * modern-monaco's code checks `error.FS_ERROR === "NOT_FOUND"` to silently
 * handle missing files (e.g. no tsconfig.json / index.html in the project) —
 * a plain Error would break its setup walk.
 * @param {string} message
 */
function notFound(message) {
    const e = new errors.NotFound(message);
    /** @type {any} */ (e).FS_ERROR = "NOT_FOUND";
    return e;
}

/** Node-like path join, always forward slashes, no trailing slash. */
function join(dir, name) {
    const cleanDir = dir.replace(/^\/+|\/+$/g, "");
    return cleanDir ? `${cleanDir}/${name}` : name;
}

/**
 * Normalize modern-monaco paths to a clean rel path. Handles "/a/b", "a/b",
 * and file URIs like "file:/a/b" / "file:///a/b" that their module
 * resolution sometimes passes back.
 */
function rel(path) {
    return String(path)
        .replace(/^file:\/+/, "")
        .replace(/^\/+|\/+$/g, "");
}

export class WebFsMonacoAdapter {
    /** @returns {NonNullable<typeof workspace.fs>["root"]} */
    #root() {
        const fs = workspace.fs?.root;
        if (!fs) throw new Error("No workspace open");
        return fs;
    }

    /** @returns {Promise<{ type: 0|1|2|64, ctime: number, mtime: number, version: number, size: number }>} */
    async stat(filename) {
        try {
            const s = await this.#root().stat(`/${rel(filename)}`);
            return {
                type: s.isDirectory ? DIR : FILE,
                ctime: s.ctimeMs ?? 0,
                mtime: s.mtimeMs ?? 0,
                version: s.mtimeMs ?? 0,
                size: s.size ?? 0,
            };
        } catch {
            throw notFound(`File not found: ${filename}`);
        }
    }

    /** @returns {Promise<Uint8Array>} */
    async readFile(filename) {
        try {
            const data = await this.#root().readFile(`/${rel(filename)}`);
            if (data instanceof ArrayBuffer) return new Uint8Array(data);
            if (ArrayBuffer.isView(data)) return new Uint8Array(/** @type {any} */ (data).buffer);
            return new TextEncoder().encode(/** @type {string} */ (data));
        } catch {
            throw notFound(`File not found: ${filename}`);
        }
    }

    /** @returns {Promise<string>} */
    async readTextFile(filename) {
        try {
            return /** @type {string} */ (await this.#root().readFile(`/${rel(filename)}`, "utf8"));
        } catch {
            throw notFound(`File not found: ${filename}`);
        }
    }

    /** @returns {Promise<[string, 0|1|2|64][]>} */
    async readDirectory(dirname) {
        const base = rel(dirname);
        let names;
        try {
            names = await this.#root().readdir(`/${base}`);
        } catch {
            throw notFound(`Directory not found: ${dirname}`);
        }
        return Promise.all(names.map(async (name) => {
            try {
                const s = await this.#root().stat(`/${join(base, name)}`);
                return /** @type {[string, 0|1|2|64]} */ ([name, s.isDirectory ? DIR : FILE]);
            } catch {
                return /** @type {[string, 0|1|2|64]} */ ([name, 0]);
            }
        }));
    }

    /**
     * @param {string} filename
     * @param {string | Uint8Array} content
     */
    async writeFile(filename, content) {
        await this.#root().writeFile(`/${rel(filename)}`, content);
    }

    /** @param {string} dirname */
    async createDirectory(dirname) {
        await this.#root().mkdir(`/${rel(dirname)}`);
    }

    /**
     * @param {string} filename
     * @param {{ recursive?: boolean }} [options]
     */
    async delete(filename, options) {
        await this.#root().rm(`/${rel(filename)}`, { recursive: !!options?.recursive });
    }

    /** @param {string} oldName @param {string} newName */
    async rename(oldName, newName) {
        await this.#root().rename(`/${rel(oldName)}`, `/${rel(newName)}`);
    }

    /**
     * @param {string} source
     * @param {string} target
     */
    async copy(source, target) {
        const src = `/${rel(source)}`;
        const dst = `/${rel(target)}`;
        const fs = this.#root();
        const s = await fs.stat(src);
        if (s.isDirectory) {
            await fs.mkdir(dst);
            for (const name of await fs.readdir(src)) {
                await this.copy(join(rel(source), name), join(rel(target), name));
            }
        } else {
            await fs.writeFile(dst, await fs.readFile(src));
        }
    }

    /**
     * Watch files/directories for changes. Backed by the bus "fs:changed"
     * event (emitted by the FS observer), so it works for the File System
     * Access API and OPFS alike.
     *
     * d.ts overloads: watch(path, {recursive}, handle) | watch(path, handle).
     * handle is called as handle(kind, filename, type).
     *
     * @param {string} filename
     * @param {{ recursive?: boolean } | ((kind: "create"|"modify"|"remove", filename: string, type?: number) => void)} optionsOrHandle
     * @param {(kind: "create"|"modify"|"remove", filename: string, type?: number) => void} [maybeHandle]
     * @returns {() => void} unsubscribe
     */
    watch(filename, optionsOrHandle, maybeHandle) {
        const handle = typeof optionsOrHandle === "function" ? optionsOrHandle : maybeHandle;
        if (!handle) return () => {};
        const prefix = rel(filename);
        const unsub = bus.on("fs:changed", ({ detail }) => {
            const p = rel(detail.path);
            if (p !== prefix && !p.startsWith(`${prefix}/`)) return;
            const kind = detail.type === "deleted" ? "remove" : detail.type === "appeared" ? "create" : "modify";
            handle(/** @type {"create"|"modify"|"remove"} */ (kind), p, detail.type === "deleted" ? undefined : FILE);
        });
        return unsub;
    }
}

/** @type {Workspace | null} singleton — modern-monaco binds it to monaco once */
let mmWorkspace = null;

/**
 * The modern-monaco Workspace backed by the active app workspace FS.
 * @returns {Workspace}
 */
export function getMonacoWorkspace() {
    if (!mmWorkspace) {
        mmWorkspace = new Workspace({
            name: "dataverse-workspace",
            customFS: /** @type {any} */ (new WebFsMonacoAdapter()),
        });
    }
    return mmWorkspace;
}
