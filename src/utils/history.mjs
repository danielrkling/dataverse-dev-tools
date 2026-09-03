import { Effect } from "effect";

const DB_NAME = "filesystem-db";
const STORE_NAME = "history";
const DB_VERSION = 2;

/** @returns {Promise<IDBDatabase>} */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * @param {string} key
 * @param {string[]} history
 * @returns {Promise<void>}
 */
export async function saveCommandHistory(key, history) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put({ key, history });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function loadCommandHistory(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result?.history ?? []);
        req.onerror = () => reject(req.error);
    });
}

/**
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function clearCommandHistory(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ---------------------------------------------------------------------------
// Effect variants (typed errors; same IndexedDB behavior)
// ---------------------------------------------------------------------------

/** @typedef {{ _tag: "IdbError", operation: "open" | "save" | "load" | "clear", cause: unknown }} IdbError */

/**
 * Factory for the typed failure of the `*CommandHistoryEffect` functions.
 * `operation` tells you which IndexedDB step failed.
 *
 * @param {{ operation: "open" | "save" | "load" | "clear", cause: unknown }} props
 * @returns {IdbError}
 */
export const IdbError = (props) => ({
    _tag: /** @type {const} */ ("IdbError"),
    ...props,
});

/**
 * Wrap an IDB transaction request as an Effect.
 *
 * @param {IDBDatabase} db
 * @param {"readwrite" | "readonly"} mode
 * @param {(store: IDBObjectStore) => IDBRequest<any>} run
 * @param {"save" | "load" | "clear"} operation
 * @returns {Effect.Effect<any, IdbError, never>}
 */
function withStore(db, mode, run, operation) {
    return Effect.async((resume) => {
        const tx = db.transaction(STORE_NAME, mode);
        const req = run(tx.objectStore(STORE_NAME));
        tx.oncomplete = () => resume(Effect.succeed(req.result));
        tx.onerror = () => resume(Effect.fail(IdbError({ operation, cause: tx.error })));
        tx.onabort = () => resume(Effect.fail(IdbError({ operation, cause: tx.error })));
    });
}

/**
 * Effect version of {@link saveCommandHistory}.
 *
 * @param {string} key
 * @param {string[]} history
 * @returns {Effect.Effect<void, IdbError, never>}
 */
export function saveCommandHistoryEffect(key, history) {
    return Effect.tryPromise({
        try: () => openDB(),
        catch: (cause) => IdbError({ operation: "open", cause }),
    }).pipe(
        Effect.flatMap((db) => withStore(db, "readwrite", (store) => store.put({ key, history }), "save")),
        Effect.asVoid,
    );
}

/**
 * Effect version of {@link loadCommandHistory}.
 *
 * @param {string} key
 * @returns {Effect.Effect<string[], IdbError, never>}
 */
export function loadCommandHistoryEffect(key) {
    return Effect.tryPromise({
        try: () => openDB(),
        catch: (cause) => IdbError({ operation: "open", cause }),
    }).pipe(
        Effect.flatMap((db) => withStore(db, "readonly", (store) => store.get(key), "load")),
        Effect.map((result) => result?.history ?? []),
    );
}

/**
 * Effect version of {@link clearCommandHistory}.
 *
 * @param {string} key
 * @returns {Effect.Effect<void, IdbError, never>}
 */
export function clearCommandHistoryEffect(key) {
    return Effect.tryPromise({
        try: () => openDB(),
        catch: (cause) => IdbError({ operation: "open", cause }),
    }).pipe(
        Effect.flatMap((db) => withStore(db, "readwrite", (store) => store.delete(key), "clear")),
        Effect.asVoid,
    );
}
