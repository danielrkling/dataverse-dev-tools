/** @type {Set<Window>} */
export const previewWindows = new Set();

/** @param {Window} win */
export function registerPreviewWindow(win) {
    previewWindows.add(win);
}
