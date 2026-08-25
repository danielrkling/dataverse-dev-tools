import { WebFileSystem } from "./fs.mjs";
import { bus } from "./bus.mjs";
import { debounce } from "../utils/debounce.mjs";

/** @type {FileSystemObserver | null} */
let rootObserver = null;

/**
 * The terminal the current workspace was opened with. Only used to keep
 * dispatching legacy compat events during migration.
 * @type {import("../terminal.mjs").WebTerminal | null}
 */
let activeTerminal = null;

/**
 * The workspace is the single owner of "which folder is currently open".
 * Panels and commands must never assign filesystems directly — they call
 * workspace.open() and react to bus events.
 *
 * Compatibility: during migration, open() also assigns the fs onto the
 * terminal and keeps dispatching the legacy terminal events ("fs:init",
 * "fs:modified", "fs:deleted") that existing commands listen to.
 */
export const workspace = {
    /** @type {WebFileSystem | null} The active file system, or null before a folder is opened. */
    fs: null,

    /**
     * Open a directory handle as the active workspace.
     * @param {WebFileSystem} fs
     * @param {import("../terminal.mjs").WebTerminal} [terminal] legacy target for compat events
     * @returns {Promise<boolean>} whether the workspace was opened successfully
     */
    async open(fs, terminal) {
        const permission = await fs.verifyPermission();
        if (!permission) return false;

        if (terminal) {
            await terminal._persistHistory();
        }

        saveHandle(fs.rootName, fs.rootHandle);
        this.fs = fs;
        window.fs = fs; // legacy global, kept for command compat
        activeTerminal = terminal ?? null;

        if (terminal) {
            terminal.log(`Loading ${fs.rootName}`);
            terminal.prompt = fs.rootName;
            terminal.loadHistory(fs.rootName);
            // Legacy event — new code should listen on the bus instead.
            terminal.dispatchEvent(new CustomEvent("fs:init"));
        }
        bus.emit("workspace:open", fs);

        await createObserver();
        return true;
    },

    /**
     * Prompt the user to pick a folder and open it as the active workspace.
     * @param {import("../terminal.mjs").WebTerminal} [terminal]
     * @returns {Promise<boolean>}
     */
    async openPicker(terminal) {
        try {
            return await this.open(await WebFileSystem.fromPicker(), terminal);
        } catch (error) {
            console.error("Folder picker failed:", error);
            return false;
        }
    },

    /**
     * Open a recently used folder by its stored id.
     * @param {string} id
     * @param {import("../terminal.mjs").WebTerminal} [terminal]
     * @throws if no recent folder with that id exists
     */
    async openRecent(id, terminal) {
        const stored = await getHandle(id);
        if (!stored) {
            throw new Error(`No Recent folder found with name ${id}`);
        }
        return this.open(new WebFileSystem(stored), terminal);
    },
};

/**
 * Watch the active workspace for external changes and emit bus + legacy events.
 */
async function createObserver() {
    if (rootObserver) {
        rootObserver.disconnect();
        rootObserver = null;
    }
    if (!workspace.fs) return;

    const observer = new FileSystemObserver((records) => {
        for (const record of records) {
            const path = record.relativePathComponents.join("/");
            const name = record.relativePathComponents.at(-1);
            if (name === "desktop.ini" || (name && name.endsWith(".crswap"))) continue;

            /** @type {"modified" | "deleted" | undefined} */
            let type;
            if (record.type === "appeared" || record.type === "modified") {
                type = "modified";
            } else if (record.type === "disappeared") {
                type = "deleted";
            } else if (record.type === "moved") {
                type = "modified";
            } else {
                continue;
            }

            debounce(100, `fs:${path}`, () => {
                bus.emit("fs:changed", { path, type });
                // Legacy events for existing commands that listen on the terminal.
                const legacyType = type === "deleted" ? "fs:deleted" : "fs:modified";
                const legacyEvent = new CustomEvent(legacyType, { detail: { path } });
                activeTerminal?.dispatchEvent(legacyEvent);
                window.dispatchEvent(new CustomEvent(legacyType, { detail: { path } }));
            });
        }
    });

    await observer.observe(workspace.fs.rootHandle, { recursive: true });
    rootObserver = observer;
}

// --- Persistent handle storage (IndexedDB) ---
// Moved from commands/open.mjs so panels can restore workspaces without
// importing anything from a command module.

const DB_NAME = "filesystem-db";
const HANDLE_STORE = "handles";
const HISTORY_STORE = "history";
const DB_VERSION = 2;

/**
 * @typedef {Object} StoredHandle
 * @property {string} id
 * @property {FileSystemDirectoryHandle} handle
 * @property {number} savedAt
 */

/** @returns {Promise<IDBDatabase>} */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;

            if (!db.objectStoreNames.contains(HANDLE_STORE)) {
                db.createObjectStore(HANDLE_STORE, {
                    keyPath: "id",
                });
            }
            if (!db.objectStoreNames.contains(HISTORY_STORE)) {
                db.createObjectStore(HISTORY_STORE, { keyPath: "key" });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * @param {string} id
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<void>}
 */
export async function saveHandle(id, handle) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, "readwrite");

        tx.objectStore(HANDLE_STORE).put({
            id,
            handle,
            savedAt: Date.now(),
        });

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * @param {string} id
 * @returns {Promise<FileSystemDirectoryHandle | null>}
 */
export async function getHandle(id) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, "readonly");
        const req = tx.objectStore(HANDLE_STORE).get(id);

        req.onsuccess = () => {
            resolve(req.result?.handle ?? null);
        };

        req.onerror = () => reject(req.error);
    });
}

/** @returns {Promise<StoredHandle[]>} */
export async function listHandles() {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, "readonly");
        const req = tx.objectStore(HANDLE_STORE).getAll();

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteHandle(id) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLE_STORE, "readwrite");

        tx.objectStore(HANDLE_STORE).delete(id);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
