/**
 * The workspace service — single owner of "which folder is currently open".
 *
 * Effect-ified change dispatch: FileSystemObserver records are pushed into an
 * Effect Queue and drained by a Stream pipeline (filter → normalize → emit),
 * replacing the old ad-hoc `setTimeout` debounce layer. The 100ms per-path
 * debounce was identified as redundant: every downstream consumer of
 * "fs:changed" already coalesces bursts (the esbuild / dataverse watch
 * pipelines debounce via Stream.debounce + semaphore, file-tree debounces its
 * git-status refresh itself), so events are now dispatched immediately.
 *
 * Public API is unchanged:
 * - `workspace` singleton (`.fs`, `.open`, `.openPicker`, `.openRecent`)
 * - `saveHandle` / `getHandle` / `listHandles` / `deleteHandle`
 * - bus events "workspace:open" and "fs:changed" with identical payloads
 * - legacy terminal/window "fs:modified" / "fs:deleted" CustomEvents
 *
 * Consumers: components/file-tree.mjs, components/editor-pane.mjs,
 * components/terminal.mjs, services/editor.mjs, commands/npm.mjs (via bus).
 */
import { WebFileSystem } from "./fs.mjs";
import { bus } from "./bus.mjs";
import { Effect, Queue, Stream, Fiber, Option } from "effect";

// ---------------------------------------------------------------------------
// Typed errors (JSDoc-friendly _tag factories — see effects/dataverse-service.mjs)
// ---------------------------------------------------------------------------

/** @typedef {{ _tag: "WorkspaceOpenError", cause: unknown, message: string }} WorkspaceOpenError */
export const WorkspaceOpenError = (/** @type {{ cause: unknown }} */ props) => ({
    _tag: /** @type {const} */ ("WorkspaceOpenError"),
    message: /** @type {any} */ (props.cause)?.message ?? "failed to open workspace",
    ...props,
});

/** @typedef {{ _tag: "NoRecentFolderError", id: string, message: string }} NoRecentFolderError */
export const NoRecentFolderError = (/** @type {string} */ id) => ({
    _tag: /** @type {const} */ ("NoRecentFolderError"),
    id,
    message: `No Recent folder found with name ${id}`,
});

/** @typedef {{ _tag: "HandleStoreError", operation: string, id?: string, cause: unknown, message: string }} HandleStoreError */
export const HandleStoreError = (/** @type {{ operation: string, id?: string, cause: unknown }} */ props) => ({
    _tag: /** @type {const} */ ("HandleStoreError"),
    message: /** @type {any} */ (props.cause)?.message ?? `handle store ${props.operation} failed`,
    ...props,
});

/** @typedef {WorkspaceOpenError | NoRecentFolderError | HandleStoreError} WorkspaceError */

// ---------------------------------------------------------------------------
// Effect-native change dispatch (replaces the setTimeout debounce layer)
// ---------------------------------------------------------------------------

/**
 * A normalized change event ready for the bus.
 * @typedef {{ path: string, type: "modified" | "deleted" }} WorkspaceChangeEvent
 */

/** @type {Queue.Queue<any> | null} */
let changeQueue = null;

/** @type {Fiber.RuntimeFiber<void, never> | null} */
let drainFiber = null;

/**
 * Normalize a raw FileSystemObserver record into a change event, or null when
 * the record should be dropped.
 *
 * Defensive: observer records (esp. during write bursts like git clone) can
 * arrive with missing/malformed relativePathComponents — emitting a
 * { path: undefined } event crashes every listener.
 *
 * @param {any} record
 * @returns {WorkspaceChangeEvent | null}
 */
function normalizeRecord(record) {
    const components = record?.relativePathComponents;
    if (!Array.isArray(components)) return null;
    const path = components.join("/");
    if (!path) return null; // root-level change — per-file handlers can't use it
    const name = components.at(-1);
    if (name === "desktop.ini" || (name && name.endsWith(".crswap"))) return null;

    if (record.type === "appeared" || record.type === "modified" || record.type === "moved") {
        return { path, type: "modified" };
    }
    if (record.type === "disappeared") {
        return { path, type: "deleted" };
    }
    return null;
}

/**
 * Start the change dispatcher once: records → filter/normalize → emit bus +
 * legacy events. Runs for the lifetime of the page; reopening a workspace
 * only swaps the FileSystemObserver feeding the queue.
 */
function ensureChangePipeline() {
    if (changeQueue && drainFiber) return;

    changeQueue = Effect.runSync(Queue.unbounded());

    const program = Stream.fromQueue(changeQueue).pipe(
        Stream.filterMap((/** @type {any} */ record) => {
            const event = normalizeRecord(record);
            return event ? Option.some(event) : Option.none();
        }),
        Stream.mapEffect((event) =>
            Effect.sync(() => {
                bus.emit("fs:changed", event);
                // Legacy events for existing commands that listen on the terminal.
                const legacyType = event.type === "deleted" ? "fs:deleted" : "fs:modified";
                const legacyEvent = new CustomEvent(legacyType, { detail: { path: event.path } });
                activeTerminal?.dispatchEvent(legacyEvent);
                window.dispatchEvent(new CustomEvent(legacyType, { detail: { path: event.path } }));
            }),
        ),
        Stream.runDrain,
    );

    drainFiber = Effect.runFork(program);
}

/** @type {FileSystemObserver | null} */
let rootObserver = null;

/**
 * Watch the active workspace for external changes and push records into the
 * change pipeline.
 */
async function createObserver() {
    if (rootObserver) {
        rootObserver.disconnect();
        rootObserver = null;
    }
    if (!workspace.fs) return;
    // FileSystemObserver is Chromium-only and experimental — on browsers
    // without it the app simply doesn't get fs:changed events (the npm
    // command's explicit re-hydration hooks still cover installs).
    if (!("FileSystemObserver" in self)) return;

    ensureChangePipeline();

    const observer = new FileSystemObserver((/** @type {any[]} */ records) => {
        for (const record of records) {
            Effect.runSync(Queue.offer(/** @type {Queue.Queue<any>} */ (changeQueue), record));
        }
    });

    await observer.observe(workspace.fs.rootHandle, { recursive: true });
    rootObserver = observer;
}

// ---------------------------------------------------------------------------
// The workspace singleton
// ---------------------------------------------------------------------------

/**
 * The terminal the current workspace was opened with. Only used to keep
 * dispatching legacy compat events during migration.
 * @type {import("../components/terminal.mjs").WebTerminal | null}
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
     * @param {import("../components/terminal.mjs").WebTerminal} [terminal] legacy target for compat events
     * @returns {Promise<boolean>} whether the workspace was opened successfully
     */
    open(fs, terminal) {
        return Effect.runPromise(
            Effect.gen(function* () {
                const permission = yield* Effect.tryPromise({
                    try: () => fs.verifyPermission(),
                    catch: (cause) => WorkspaceOpenError({ cause }),
                });
                if (!permission) return false;

                if (terminal) {
                    yield* Effect.tryPromise({
                        try: () => terminal._persistHistory(),
                        catch: (cause) => WorkspaceOpenError({ cause }),
                    });
                }

                yield* Effect.sync(() => {
                    // Fire-and-forget, as before.
                    Effect.runPromise(saveHandleEffect(fs.rootName, fs.rootHandle)).catch((error) =>
                        console.error("Failed to persist recent folder:", error),
                    );
                    workspace.fs = fs;
                    window.fs = fs; // legacy global, kept for command compat
                    activeTerminal = terminal ?? null;
                });

                if (terminal) {
                    yield* Effect.sync(() => {
                        terminal.log(`Loading ${fs.rootName}`);
                        terminal.prompt = fs.rootName;
                        terminal.loadHistory(fs.rootName);
                        // Legacy event — new code should listen on the bus instead.
                    });
                }

                yield* Effect.sync(() => bus.emit("workspace:open", fs));
                yield* Effect.tryPromise({
                    try: () => createObserver(),
                    catch: (cause) => WorkspaceOpenError({ cause }),
                });
                return true;
            }),
        );
    },

    /**
     * Prompt the user to pick a folder and open it as the active workspace.
     * @param {import("../components/terminal.mjs").WebTerminal} [terminal]
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
     * @param {import("../components/terminal.mjs").WebTerminal} [terminal]
     * @throws {NoRecentFolderError} if no recent folder with that id exists
     */
    async openRecent(id, terminal) {
        const stored = await getHandle(id);
        if (!stored) {
            throw NoRecentFolderError(id);
        }
        return this.open(new WebFileSystem(stored), terminal);
    },
};

// ---------------------------------------------------------------------------
// Persistent workspace storage (Single store: handle + history)
// ---------------------------------------------------------------------------

const DB_NAME = "filesystem-db";
const WORKSPACE_STORE = "workspaces"; // Unified store name (or "handles")
const DB_VERSION = 3; // Bumped to 3 to trigger onupgradeneeded across all browsers

/**
 * @typedef {Object} WorkspaceRecord
 * @property {string} id - root folder name / key
 * @property {FileSystemDirectoryHandle} [handle]
 * @property {string[]} [history]
 * @property {number} [savedAt]
 */

/**
 * @returns {Effect.Effect<IDBDatabase, HandleStoreError, never>}
 */
function openDBEffect() {
    return Effect.tryPromise({
        try: () =>
            new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);

                request.onupgradeneeded = () => {
                    const db = request.result;
                    // Create single unified store with keyPath "id"
                    if (!db.objectStoreNames.contains(WORKSPACE_STORE)) {
                        db.createObjectStore(WORKSPACE_STORE, { keyPath: "id" });
                    }
                };

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            }),
        catch: (cause) => HandleStoreError({ operation: "openDB", cause }),
    });
}

/**
 * @param {IDBDatabase} db
 * @param {IDBRequest<any>} req
 * @returns {Effect.Effect<any, HandleStoreError, never>}
 */
function requestEffect(db, req) {
    return Effect.tryPromise({
        try: () =>
            new Promise((resolve, reject) => {
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            }),
        catch: (cause) => HandleStoreError({ operation: "request", cause }),
    });
}

/**
 * Upsert fields for a workspace entry without overwriting other existing fields.
 * @param {string} id
 * @param {Partial<WorkspaceRecord>} updates
 */
function updateWorkspaceRecordEffect(id, updates) {
    return Effect.gen(function* () {
        const db = yield* openDBEffect();
        yield* Effect.tryPromise({
            try: () =>
                new Promise((resolve, reject) => {
                    const tx = db.transaction(WORKSPACE_STORE, "readwrite");
                    const store = tx.objectStore(WORKSPACE_STORE);
                    const getReq = store.get(id);

                    getReq.onsuccess = () => {
                        const existing = getReq.result || { id };
                        const merged = { ...existing, ...updates, id };
                        store.put(merged);
                    };

                    tx.oncomplete = () => resolve(undefined);
                    tx.onerror = () => reject(tx.error);
                }),
            catch: (cause) => HandleStoreError({ operation: "updateWorkspaceRecord", id, cause }),
        });
    }).pipe(Effect.asVoid);
}

// --- Handle Operations ---

/**
 * @param {string} id
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Effect.Effect<void, HandleStoreError, never>}
 */
export function saveHandleEffect(id, handle) {
    return updateWorkspaceRecordEffect(id, { handle, savedAt: Date.now() });
}

/**
 * @param {string} id
 * @returns {Effect.Effect<FileSystemDirectoryHandle | null, HandleStoreError, never>}
 */
export function getHandleEffect(id) {
    return Effect.gen(function* () {
        const db = yield* openDBEffect();
        const tx = db.transaction(WORKSPACE_STORE, "readonly");
        const req = tx.objectStore(WORKSPACE_STORE).get(id);
        const result = yield* requestEffect(db, req);
        return /** @type {WorkspaceRecord} */ (result)?.handle ?? null;
    });
}

/** @returns {Effect.Effect<WorkspaceRecord[], HandleStoreError, never>} */
export function listHandlesEffect() {
    return Effect.gen(function* () {
        const db = yield* openDBEffect();
        const tx = db.transaction(WORKSPACE_STORE, "readonly");
        const all = yield* requestEffect(db, tx.objectStore(WORKSPACE_STORE).getAll());
        // Filter to records that have a directory handle saved
        return (all || []).filter((/** @type {{ handle?: unknown }} */ r) => r.handle != null);
    });
}

/**
 * @param {string} id
 * @returns {Effect.Effect<void, HandleStoreError, never>}
 */
export function deleteHandleEffect(id) {
    return Effect.gen(function* () {
        const db = yield* openDBEffect();
        yield* Effect.tryPromise({
            try: () =>
                new Promise((resolve, reject) => {
                    const tx = db.transaction(WORKSPACE_STORE, "readwrite");
                    tx.objectStore(WORKSPACE_STORE).delete(id);
                    tx.oncomplete = () => resolve(undefined);
                    tx.onerror = () => reject(tx.error);
                }),
            catch: (cause) => HandleStoreError({ operation: "deleteHandle", id, cause }),
        });
    }).pipe(Effect.asVoid);
}

// --- History Operations ---

/**
 * @param {string} id
 * @param {string[]} history
 * @returns {Effect.Effect<void, HandleStoreError, never>}
 */
export function saveCommandHistoryEffect(id, history) {
    return updateWorkspaceRecordEffect(id, { history });
}

/**
 * @param {string} id
 * @returns {Effect.Effect<string[], HandleStoreError, never>}
 */
export function loadCommandHistoryEffect(id) {
    return Effect.gen(function* () {
        const db = yield* openDBEffect();
        const tx = db.transaction(WORKSPACE_STORE, "readonly");
        const req = tx.objectStore(WORKSPACE_STORE).get(id);
        const result = yield* requestEffect(db, req);
        return /** @type {WorkspaceRecord} */ (result)?.history ?? [];
    });
}

/**
 * @param {string} id
 * @returns {Effect.Effect<void, HandleStoreError, never>}
 */
export function clearCommandHistoryEffect(id) {
    return updateWorkspaceRecordEffect(id, { history: [] });
}

// --- Promise Helpers (for legacy/non-Effect callers) ---

/** @param {string} id @param {FileSystemDirectoryHandle} handle */
export const saveHandle = (id, handle) => Effect.runPromise(saveHandleEffect(id, handle));
/** @param {string} id */
export const getHandle = (id) => Effect.runPromise(getHandleEffect(id));
export const listHandles = () => Effect.runPromise(listHandlesEffect());
/** @param {string} id */
export const deleteHandle = (id) => Effect.runPromise(deleteHandleEffect(id));

/** @param {string} id @param {string[]} history */
export const saveCommandHistory = (id, history) => Effect.runPromise(saveCommandHistoryEffect(id, history));
/** @param {string} id */
export const loadCommandHistory = (id) => Effect.runPromise(loadCommandHistoryEffect(id));
/** @param {string} id */
export const clearCommandHistory = (id) => Effect.runPromise(clearCommandHistoryEffect(id));
