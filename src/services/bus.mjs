/**
 * A tiny typed event bus built on EventTarget.
 *
 * Panels and services communicate exclusively through this bus so that no
 * component ever imports another component (one-way deps: panels -> services).
 *
 * Events emitted by the app:
 * - "workspace:open"   { fs: WebFileSystem }              a folder became active
 * - "fs:changed"       { path: string, type: ChangeType } a path changed on disk
 * - "editor:open"      { path: string }                   request to open a file in the editor
 *
 * @typedef {"modified" | "deleted" | "moved"} FsChangeType
 */

class EventBus extends EventTarget {
    /**
     * Subscribe to an event.
     * @template {keyof EventDetail} T
     * @param {T} type
     * @param {(event: CustomEvent<EventDetail[T]>) => void} handler
     * @returns {() => void} unsubscribe function
     */
    on(type, handler) {
        this.addEventListener(type, /** @type {any} */ (handler));
        return () => this.off(type, handler);
    }

    /**
     * Unsubscribe from an event.
     * @param {string} type
     * @param {(...args: any[]) => void} handler
     */
    off(type, handler) {
        this.removeEventListener(type, /** @type {any} */ (handler));
    }

    /**
     * Emit an event with a detail payload.
     * @template {keyof EventDetail} T
     * @param {T} type
     * @param {EventDetail[T]} [detail]
     */
    emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}

/**
 * @typedef {{
 *     "workspace:open": import("./fs.mjs").WebFileSystem,
 *     "fs:changed": { path: string, type: FsChangeType },
 *     "editor:open": { path: string },
 * }} EventDetail
 */

/** The application-wide singleton bus. */
export const bus = new EventBus();
