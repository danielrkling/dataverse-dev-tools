import { argument, message, object, optional, string } from "@optique/core";
import { createCommand, WebTerminal } from "../terminal.mjs";
import { createDebouncer } from "../utils/debounce.mjs";
import { WebFileSystem } from "../fs.mjs";

/** @type {FileSystemObserver | null} */
let rootObserver = null;

// export class FSChange extends CustomEvent {
//     /**
//      * @param {'modified'|'deleted'} type
//      * @param {string} path
//      */
//     constructor(type, path) {
//         super("fs:change", {
//             detail: { path, type },
//         });
//     }
// }

export const openCommand = createCommand({
    name: "open",
    aliases: ["o"],
    description: message`Open new or recent directory`,
    usage: message`open [<folder_name>]`,
    brief: message`Open new or recent directory`,
    parser: object({
        path: optional(
            argument(string({ metavar: "PATH" }), {
                description: message`Recent Directory to open`,
            }),
        ),
    }),
    execute: async (parsed, terminal) => {
        if (parsed.path) {
            const handle = await getHandle(parsed.path);
            if (handle) {
                loadFS(terminal, new WebFileSystem(handle));
            } else {
                throw new Error(`No Recent folder found with name ${parsed.path}`);
            }
        } else {
            loadFS(terminal, await WebFileSystem.fromPicker());
        }
    },
    init: async (terminal) => {
        const recentFolders = await listHandles();
        const elem = document.createElement("div");
        elem.append(`Select a recent folder or open a new one`);

        for (const folder of recentFolders) {
            const button = document.createElement("button");
            button.innerText = `  ${folder.id}`;

            button.onclick = () => {
                loadFS(terminal, new WebFileSystem(folder.handle));
                elem.innerHTML = "";
            };
            elem.appendChild(button);
        }

        const button = document.createElement("button");
        button.innerText = "  Select New Folder";
        button.onclick = async () => {
            loadFS(terminal, await WebFileSystem.fromPicker());
            elem.innerHTML = "";
        };
        elem.appendChild(button);

        terminal.log(elem);
    },
});

/**
 * @param {WebTerminal} terminal
 * @param {WebFileSystem} fs
 */
async function loadFS(terminal, fs) {
    const permission = await fs.verifyPermission();
    if (permission) {
        saveHandle(fs.rootName, fs.rootHandle);
        terminal.fs = fs;

        window.fs = fs;

        terminal.log(`Loading ${fs.rootName}`);
        terminal.prompt = fs.rootName;

        terminal.dispatchEvent(new CustomEvent("fs:init"))
        

        await createObserver(terminal);
    } else {
        terminal.error(`Invalid permissions`);
    }
}

const debounceEmit = createDebouncer(150);

/**
 *
 * @param {WebTerminal} terminal
 */
async function createObserver(terminal) {
    if (rootObserver) {
        rootObserver.disconnect();
        rootObserver = null;
    }

    const observer = new FileSystemObserver((records) => {
        for (const record of records) {
            const path = record.relativePathComponents.join("/");
            const name = record.relativePathComponents.at(-1);
            if (name === "desktop.ini" || (name && name.endsWith(".crswap"))) continue;

            if (record.type === "appeared" || record.type === "modified") {
                debounceEmit(path, () => terminal.dispatchEvent(new CustomEvent("fs:modified", { detail: { path } })));
            } else if (record.type === "disappeared") {
                debounceEmit(path, () => terminal.dispatchEvent(new CustomEvent("fs:deleted", { detail: { path } })));
            } else if (record.type === "moved") {
                debounceEmit(path, () => terminal.dispatchEvent(new CustomEvent("fs:modified", { detail: { path } })));
            } else {
                continue;
            }
        }
    });

    await observer.observe(terminal.fs.rootHandle, { recursive: true });
    rootObserver = observer;
}

const DB_NAME = "filesystem-db";
const STORE_NAME = "handles";
const DB_VERSION = 1;

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

            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, {
                    keyPath: "id",
                });
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
        const tx = db.transaction(STORE_NAME, "readwrite");

        tx.objectStore(STORE_NAME).put({
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
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(id);

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
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).getAll();

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
        const tx = db.transaction(STORE_NAME, "readwrite");

        tx.objectStore(STORE_NAME).delete(id);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
