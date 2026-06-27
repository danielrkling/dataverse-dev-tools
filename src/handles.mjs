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
