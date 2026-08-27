import { FileTree, prepareFileTreeInput } from "@pierre/trees";
import "@pierre/trees/web-components"; // registers <file-tree-container> + styles
// The Web Awesome autoloader (index.html) only watches the light DOM — it
// can't see inside this shadow root, so components used here are imported
// explicitly to guarantee registration.
import "https://ka-f.webawesome.com/webawesome@3.12.0/components/button/button.js";
import "https://ka-f.webawesome.com/webawesome@3.12.0/components/icon/icon.js";
import "https://ka-f.webawesome.com/webawesome@3.12.0/components/spinner/spinner.js";
import { bus } from "../services/bus.mjs";
import { workspace, listHandles, deleteHandle } from "../services/workspace.mjs";
import { WebFileSystem } from "../services/fs.mjs";
import { scanPaths } from "../utils/scan-paths.mjs";

/**
 * Sidebar file tree, backed by @pierre/trees (loaded from the CDN import map).
 *
 * This element is a thin adapter between our services and the library:
 * - "workspace:open"  -> scan workspace.fs and resetPaths()
 * - "fs:changed"      -> incremental tree.add() / tree.remove()
 * - selection/rename/context menu -> fs mutations + bus "editor:open"
 */
export class FileTreePane extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        /** @type {FileTree | null} */
        this._tree = null;
        /** @type {Set<string>} known directory paths */
        this._dirs = new Set();
        /** @type {(() => void)[]} */
        this._unsubs = [];
        /** @type {number} */
        this._rebuildGeneration = 0;
        /** @type {import("@pierre/trees").FileTreeOptions["preparedInput"] | null} */
        this._preparedInput = null;
        /** @type {{ path: string, isDir: boolean, cut: boolean } | null} */
        this._clipboard = null;
        /** @type {((e: KeyboardEvent) => void) | null} */
        this._onKeyDown = null;
        /** @type {HTMLElement | null} floating empty-space context menu */
        this._emptyMenu = null;

        const root = /** @type {ShadowRoot} */ (this.shadowRoot);
        root.innerHTML = `
            <style>
                :host {
                    display: flex;
                    flex-direction: column;
                    background-color: #1e1e1e;
                    color: #d4d4d4;
                    font-family: 'Consolas', 'Monaco', monospace;
                    font-size: 13px;
                    min-width: 0;
                    overflow: hidden;
                }
                header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 0.5rem 0.75rem;
                    border-bottom: 1px solid #333;
                    flex-shrink: 0;
                }
                #title {
                    font-weight: bold;
                    color: #569cd6;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .actions {
                    display: inline-flex;
                    align-items: center;
                    gap: 2px;
                }
                .actions .icon-btn {
                    --wa-button-size: 26px;
                    font-size: 14px;
                }
                /* Render WA buttons as subtle, transparent toolbar icons */
                .actions .icon-btn::part(button) {
                    all: unset;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: var(--wa-button-size, 26px);
                    height: var(--wa-button-size, 26px);
                    cursor: pointer;
                    color: #a0a0a0;
                    border-radius: 3px;
                }
                .actions .icon-btn:hover::part(button) {
                    background: #3a3a3a;
                    color: #fff;
                }
                #mount {
                    flex: 1;
                    min-height: 0;
                }
                #empty {
                    padding: 1rem;
                    color: #808080;
                }
                /* Recent-folders list rows rendered as full-width WA buttons */
                .recent-item {
                    width: 100%;
                    --wa-button-font-size: 12px;
                }
                .recent-item::part(button) {
                    all: unset;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    width: 100%;
                    box-sizing: border-box;
                    padding: 6px 10px;
                    cursor: pointer;
                    color: #d4d4d4;
                    font-size: 12px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    border-radius: 3px;
                }
                .recent-item:hover::part(button) {
                    background: #094771;
                }
                /* Remove button in the recents list: compact square, not a row */
                .remove-item {
                    flex: 0 0 auto;
                    width: 28px;
                    opacity: 0.6;
                }
                .remove-item:hover {
                    opacity: 1;
                }
                /* Loading overlay shown while the workspace is being scanned */
                #loading {
                    display: none;
                    flex: 1;
                    min-height: 0;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    color: #808080;
                    flex-direction: column;
                }
                #loading.visible {
                    display: flex;
                }
                #loading wa-spinner {
                    font-size: 1.75rem;
                    color: #569cd6;
                }
            </style>
            <header>
                <span id="title">No folder open</span>
                <span class="actions">
                    <wa-button class="icon-btn" id="new-file" aria-label="New File"><wa-icon name="file"></wa-icon></wa-button>
                    <wa-button class="icon-btn" id="new-folder" aria-label="New Folder"><wa-icon name="folder-plus"></wa-icon></wa-button>
                    <wa-button class="icon-btn" id="refresh" aria-label="Refresh"><wa-icon name="rotate-right"></wa-icon></wa-button>
                    <wa-button class="icon-btn" id="open-folder" aria-label="Open Folder"><wa-icon name="folder-open"></wa-icon></wa-button>
                </span>
            </header>
            <div id="empty">Click the folder button above to open a folder.</div>
            <div id="loading"><wa-spinner></wa-spinner><span>Loading files…</span></div>
            <div id="mount"></div>
        `;

        this._title = /** @type {HTMLSpanElement} */ (root.querySelector("#title"));
        this._empty = /** @type {HTMLDivElement} */ (root.querySelector("#empty"));
        this._mount = /** @type {HTMLDivElement} */ (root.querySelector("#mount"));
        this._loading = /** @type {HTMLDivElement} */ (root.querySelector("#loading"));

        root.querySelector("#new-file")?.addEventListener("click", () => this._createEntry("file"));
        root.querySelector("#new-folder")?.addEventListener("click", () => this._createEntry("directory"));
        root.querySelector("#refresh")?.addEventListener("click", () => this.rebuild());
        root.querySelector("#open-folder")?.addEventListener("click", () => {
            this.openFolderPicker();
        });
    }

    connectedCallback() {
        this._unsubs.push(
            bus.on("workspace:open", () => this.rebuild()),
            bus.on("fs:changed", (e) => this._onFsChanged(e.detail)),
        );

        // Context menu on empty tree space (below the rows / between them).
        // Rows are buttons with data-item-path — but they live inside
        // <file-tree-container>'s own shadow root, so e.target is retargeted
        // to the container host by the time this listener runs. Inspect the
        // composed path instead, otherwise every row right-click would ALSO
        // trigger the root menu.
        this._mount.addEventListener("contextmenu", (e) => {
            const hitRow = e
                .composedPath()
                .some((el) => el instanceof HTMLElement && el.matches?.("button[data-item-path]"));
            if (hitRow) return; // row menu handles it
            if (!workspace.fs) return;
            e.preventDefault();
            e.stopPropagation();
            this._showEmptySpaceMenu(e.clientX, e.clientY);
        });

        // Keyboard shortcuts acting on the tree selection.
        this._onKeyDown = (/** @type {KeyboardEvent} */ e) => {
            if (!workspace.fs || !this._tree) return;
            if (e.key === "F2") {
                const selected = this._tree.getSelectedPaths().at(-1);
                if (selected) {
                    e.preventDefault();
                    this._tree.startRenaming(selected);
                }
            } else if (e.key === "Delete") {
                const selected = this._tree.getSelectedPaths().at(-1)?.replace(/\/$/, "");
                if (selected) {
                    e.preventDefault();
                    this._delete(selected, this._dirs.has(selected));
                }
            }
        };
        this.addEventListener("keydown", this._onKeyDown);

        // A workspace may already be open before this element connected.
        if (workspace.fs) {
            this.rebuild();
        } else {
            this.showRecentFolders();
        }
    }

    disconnectedCallback() {
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
        this.removeEventListener("keydown", /** @type {any} */ (this._onKeyDown));
        this._tree?.cleanUp();
        this._tree = null;
    }

    /**
     * Populate the empty sidebar with recent folders + picker buttons.
     * Everything disappears once an entry is chosen.
     */
    async showRecentFolders() {
        const recents = await listHandles();

        /** @type {HTMLElement} */ (this._empty).innerHTML = "";
        this._empty.style.display = "";

        const list = document.createElement("div");
        Object.assign(list.style, { display: "flex", flexDirection: "column", gap: "2px" });

        const item = (/** @type {string} */ html, /** @type {() => Promise<void> | void} */ fn) => {
            const btn = document.createElement("wa-button");
            btn.setAttribute("appearance", "plain");
            btn.setAttribute("variant", "neutral");
            // App-controlled markup (icons + escaped labels) — see callers.
            btn.innerHTML = html;
            btn.classList.add("recent-item");
            btn.addEventListener("click", async () => {
                list.remove();
                await fn();
            });
            list.appendChild(btn);
        };

        const esc = (/** @type {string} */ s) =>
            s.replace(/[&<>"']/g, (c) =>
                ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
            );

        for (const folder of recents) {
            // Row = open button + remove (x) button.
            const row = document.createElement("div");
            Object.assign(row.style, { display: "flex", alignItems: "stretch", gap: "2px" });

            const openBtn = document.createElement("wa-button");
            openBtn.setAttribute("appearance", "plain");
            openBtn.setAttribute("variant", "neutral");
            openBtn.innerHTML = `<wa-icon name="folder-open"></wa-icon> ${esc(folder.id)}`;
            openBtn.classList.add("recent-item");
            openBtn.style.flex = "1";
            openBtn.style.minWidth = "0";
            openBtn.addEventListener("click", async () => {
                list.remove();
                try {
                    await workspace.openRecent(folder.id);
                } catch (error) {
                    console.error(error);
                    // Handle stale/unavailable — fall back to the picker.
                    await workspace.openPicker();
                }
            });

            const removeBtn = document.createElement("wa-button");
            removeBtn.setAttribute("appearance", "plain");
            removeBtn.setAttribute("variant", "neutral");
            removeBtn.classList.add("recent-item", "remove-item");
            removeBtn.setAttribute("aria-label", `Forget ${folder.id}`);
            removeBtn.title = `Forget ${folder.id}`;
            removeBtn.innerHTML = '<wa-icon name="xmark"></wa-icon>';
            removeBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                await deleteHandle(folder.id);
                await this.showRecentFolders(); // re-render the list
            });

            row.append(openBtn, removeBtn);
            list.appendChild(row);
        }

        if (recents.length > 0) {
            const hr = document.createElement("div");
            Object.assign(hr.style, { height: "1px", background: "#333", margin: "0.5rem 0.75rem" });
            list.appendChild(hr);
        }

        item(`<wa-icon name="folder-open"></wa-icon>  Select New Folder…`, () => this.openFolderPicker());
        item(`<wa-icon name="bolt"></wa-icon>  Use OPFS Workspace`, async () => {
            // Prompt for a project name so multiple OPFS projects can coexist
            // (each becomes its own directory under OPFS + its own recent).
            const raw = prompt("Project name:", "my-project");
            if (!raw) {
                this.showRecentFolders();
                return;
            }
            const dirName = raw.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "my-project";
            try {
                await workspace.open(await WebFileSystem.fromOPFS(dirName));
            } catch (error) {
                console.error("OPFS open failed:", error);
                this.showRecentFolders();
            }
        });

        this._empty.appendChild(list);
    }

    /**
     * Open the browser's directory picker as the active workspace.
     */
    async openFolderPicker() {
        const opened = await workspace.openPicker();
        if (!opened) {
            console.warn("Folder open cancelled or permission denied");
            // Bring the recents list back so the sidebar isn't blank.
            this.showRecentFolders();
        }
    }

    /** Full rescan of the workspace and re-render of the tree. */
    async rebuild() {
        const fs = workspace.fs?.root;
        if (!fs) return;

        // Guard against overlapping rebuilds (e.g. connectedCallback racing a
        // "workspace:open" event): only the latest scan may touch the tree.
        const generation = ++this._rebuildGeneration;

        this._title.textContent = fs.rootName;
        this._empty.style.display = "none";
        // Show the spinner while we walk the filesystem (may take a moment on
        // large workspaces). Hidden again once the tree is rendered below.
        this._loading.classList.add("visible");

        const { paths, dirs } = await scanPaths(fs);
        if (generation !== this._rebuildGeneration) return; // superseded
        this._dirs = dirs;
        this._preparedInput = prepareFileTreeInput(sanitizePaths(paths), {});

        if (this._tree) {
            // Existing tree: resetPaths updates its state in place. The tree DOM
            // is already mounted in #mount, so do NOT clear it here.
            this._tree.resetPaths({ preparedInput: this._preparedInput });
        } else {
            // First render: clear any placeholder, then mount the tree.
            this._mount.innerHTML = "";
            this._tree = new FileTree({
                id: "workspace-tree",
                preparedInput: this._preparedInput,
                initialExpansion: "closed",
                unsafeCSS: `
                    :where(file-tree-container) {
                        --file-tree-background: transparent;
                        height: 100%;
                        font-family: inherit;
                        font-size: inherit;
                    }
                `,
                onSelectionChange: (selectedPaths) => this._onSelectionChange(selectedPaths),
                renaming: {
                    onRename: ({ sourcePath, destinationPath }) => this._rename(sourcePath, destinationPath),
                },
                dragAndDrop: {
                    canDrag: () => workspace.fs != null,
                    canDrop: () => workspace.fs != null,
                    onDropComplete: ({ draggedPaths, target }) => this._movePaths(draggedPaths, target),
                },
                composition: {
                    contextMenu: {
                        enabled: true,
                        triggerMode: "right-click",
                        render: (item, context) => this._renderContextMenu(item, context),
                    },
                },
            });
            this._tree.render({ containerWrapper: this._mount });
        }

        // Files are loaded — drop the spinner.
        this._loading.classList.remove("visible");
    }

    /**
     * Open a file in the editor when it gets selected in the tree.
     * @param {readonly string[]} selectedPaths
     */
    _onSelectionChange(selectedPaths) {
        for (const rawPath of selectedPaths) {
            const path = rawPath.replace(/\/$/, "");
            if (!this._dirs.has(path)) {
                bus.emit("editor:open", { path });
            }
        }
    }

    /**
     * Incrementally sync external filesystem changes into the tree.
     * @param {{ path: string, type: "modified" | "deleted" | "moved" }} detail
     */
    async _onFsChanged({ path, type }) {
        const tree = this._tree;
        if (!tree || !workspace.fs) return;

        if (type === "deleted") {
            this._removeFromTree(path);
            this._dirs.delete(path);
            return;
        }

        // "modified"/"appeared": add if unknown, else no-op — content changes
        // don't affect the listing.
        if (!this._dirs.has(path)) {
            try {
                const stat = await workspace.fs.root.stat(`/${path}`);
                // Clear any stale entry so a file/dir type flip can't cause
                // an "add" collision inside the tree's path store.
                this._removeFromTree(path);
                if (stat.isDirectory) {
                    // Register any missing ancestors so the tree can expand.
                    /** @type {string[]} */
                    const missingDirs = [];
                    const segments = path.split("/");
                    for (let i = 1; i <= segments.length; i++) {
                        const prefix = segments.slice(0, i).join("/");
                        if (!this._dirs.has(prefix)) {
                            missingDirs.push(prefix);
                            this._dirs.add(prefix);
                        }
                    }
                    for (const dir of missingDirs) {
                        tree.remove(dir, { recursive: true });
                        tree.add(`${dir}/`);
                    }
                    this._dirs.add(path);
                }
                tree.add(stat.isDirectory ? `${path}/` : path);
            } catch {
                // Entry vanished again before we could stat it — ignore.
            }
        }
    }

    /**
     * Safely remove a path from the tree (no-op if the tree doesn't know it).
     * @param {string} path clean path, no trailing slash
     */
    _removeFromTree(path) {
        const tree = this._tree;
        if (!tree) return;
        if (tree.getItem(`${path}/`) != null) tree.remove(`${path}/`, { recursive: true });
        else if (tree.getItem(path) != null) tree.remove(path, { recursive: true });
    }

    /**
     * Rename through the filesystem; the observer event will sync the tree.
     * @param {string} sourcePath
     * @param {string} destinationPath
     */
    async _rename(sourcePath, destinationPath) {
        try {
            await workspace.fs?.root.rename(`/${sourcePath}`, `/${destinationPath}`);
        } catch (error) {
            console.error("Rename failed:", error);
        }
    }

    /**
     * Build a styled menu element from entries ("-" = separator).
     * @param {(string | { label: string, fn?: () => void })[]} entries
     * @param {() => void} onClose called after any entry action
     * @returns {HTMLElement}
     */
    _buildMenu(entries, onClose) {
        const menu = document.createElement("div");
        Object.assign(menu.style, {
            display: "flex",
            flexDirection: "column",
            background: "#2d2d2d",
            border: "1px solid #555",
            borderRadius: "4px",
            padding: "0.25rem 0",
            minWidth: "140px",
            fontFamily: "inherit",
            fontSize: "13px",
        });

        for (const entry of entries) {
            if (entry === "-") {
                const hr = document.createElement("div");
                Object.assign(hr.style, { height: "1px", background: "#444", margin: "0.25rem 0" });
                menu.appendChild(hr);
                continue;
            }
            const { label, fn } = /** @type {{ label: string, fn?: () => void }} */ (entry);
            const btn = document.createElement("button");
            btn.textContent = label;
            Object.assign(btn.style, {
                all: "unset",
                display: "block",
                padding: "4px 12px",
                cursor: fn ? "pointer" : "default",
                color: fn ? "#d4d4d4" : "#666",
            });
            if (!fn) continue;
            btn.addEventListener("mouseenter", () => (btn.style.background = "#094771"));
            btn.addEventListener("mouseleave", () => (btn.style.background = ""));
            btn.addEventListener("click", () => {
                fn();
                onClose();
            });
            menu.appendChild(btn);
        }

        return menu;
    }

    /**
     * Context menu rendered by @pierre/trees' composition API.
     * @param {{ path: string, name: string, kind: "directory" | "file" }} item
     * @param {{ close: (options?: { restoreFocus?: boolean }) => void }} context
     * @returns {HTMLElement}
     */
    _renderContextMenu(item, context) {
        // Directory rows carry a trailing slash in this library.
        const path = item.path.replace(/\/$/, "");
        const isDir = item.kind === "directory";

        /** @type {(string | { label: string, fn?: () => void })[]} */
        const entries = [];
        if (isDir) {
            entries.push(
                { label: "New File…", fn: () => this._createEntryIn("file", path) },
                { label: "New Folder…", fn: () => this._createEntryIn("directory", path) },
                "-",
            );
        }
        entries.push({ label: "Copy Path", fn: () => navigator.clipboard?.writeText(path) });
        entries.push("-");
        entries.push(
            { label: "Cut", fn: () => (this._clipboard = { path, isDir, cut: true }) },
            { label: "Copy", fn: () => (this._clipboard = { path, isDir, cut: false }) },
        );
        if (this._clipboard && isDir && this._clipboard.path !== path) {
            entries.push({
                label: `Paste into "${item.name}"`,
                fn: () => this._paste(path),
            });
        } else if (this._clipboard && !isDir) {
            // Pasting next to a file goes into its parent directory.
            const parentDir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
            entries.push({
                label: "Paste here",
                fn: () => this._paste(parentDir),
            });
        }
        entries.push("-");
        entries.push(
            { label: "Rename…", fn: () => this._tree?.startRenaming(item.path) },
            {
                label: isDir ? "Delete folder…" : "Delete file…",
                fn: () => this._delete(path, isDir),
            },
        );

        return this._buildMenu(entries, () => context.close());
    }

    /**
     * Floating context menu for right-clicks on empty tree space.
     * @param {number} x viewport x
     * @param {number} y viewport y
     */
    _showEmptySpaceMenu(x, y) {
        this._closeEmptyMenu();

        /** @type {(string | { label: string, fn?: () => void })[]} */
        const entries = [
            { label: "New File…", fn: () => this._createEntryIn("file", "") },
            { label: "New Folder…", fn: () => this._createEntryIn("directory", "") },
            "-",
        ];
        if (this._clipboard) {
            entries.push({ label: "Paste into root", fn: () => this._paste("") });
        }
        entries.push(
            { label: "Refresh", fn: () => this.rebuild() },
        );

        const menu = this._buildMenu(entries, () => this._closeEmptyMenu());
        Object.assign(menu.style, { position: "fixed", zIndex: "10000", boxShadow: "0 4px 16px rgba(0,0,0,.5)" });
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const dismiss = (/** @type {Event} */ e) => {
            if (menu.contains(/** @type {Node} */ (e.target))) return;
            this._closeEmptyMenu();
        };
        menu.addEventListener("click", (e) => e.stopPropagation());
        document.addEventListener("pointerdown", dismiss, true);
        window.addEventListener("blur", dismiss);
        // @ts-ignore custom cleanup hook
        menu._dismiss = () => {
            document.removeEventListener("pointerdown", dismiss, true);
            window.removeEventListener("blur", dismiss);
        };

        document.body.appendChild(menu);
        this._emptyMenu = menu;
    }

    /** Remove the floating empty-space menu, if open. */
    _closeEmptyMenu() {
        if (!this._emptyMenu) return;
        // @ts-ignore custom cleanup hook
        this._emptyMenu._dismiss?.();
        this._emptyMenu.remove();
        this._emptyMenu = null;
    }

    /**
     * Move dragged paths into a drop target directory (built-in tree DnD).
     * Uses tree.move() so the in-tree update happens without a rebuild —
     * a resetPaths() rescan collapses all expanded folders, which is jarring.
     * @param {readonly string[]} draggedPaths
     * @param {{ directoryPath: string | null, kind: "directory" | "root" }} target
     */
    async _movePaths(draggedPaths, target) {
        const fs = workspace.fs?.root;
        if (!fs) return;
        const destDir = target.kind === "directory" ? /** @type {string} */ (target.directoryPath)?.replace(/\/$/, "") ?? "" : "";

        for (const rawPath of draggedPaths) {
            const path = rawPath.replace(/\/$/, "");
            const name = path.split("/").at(-1) ?? path;
            const dest = destDir ? `${destDir}/${name}` : name;
            if (dest === path) continue;
            // Never drop a directory into itself or a descendant.
            if (destDir === path || destDir.startsWith(`${path}/`)) continue;
            try {
                const stat = await fs.stat(`/${path}`);
                await fs.rename(`/${path}`, `/${dest}`);
                // Mirror the move inside the tree (dirs carry trailing slashes).
                this._tree?.move(stat.isDirectory ? `${path}/` : path, stat.isDirectory ? `${dest}/` : dest);
                // Remap our directory registry to the new prefix.
                for (const dir of [...this._dirs]) {
                    if (dir === path || dir.startsWith(`${path}/`)) {
                        this._dirs.delete(dir);
                        this._dirs.add(dest + dir.slice(path.length));
                    }
                }
            } catch (error) {
                console.error(`Move ${path} -> ${dest} failed:`, error);
            }
        }
    }

    /**
     * Paste the clipboard entry into a target directory.
     * @param {string} targetDir "" for root
     */
    async _paste(targetDir) {
        const fs = workspace.fs?.root;
        const clip = this._clipboard;
        if (!fs || !clip) return;

        const name = /** @type {string} */ (clip.path.split("/").at(-1));
        let dest = targetDir ? `${targetDir}/${name}` : name;

        // Avoid overwriting: suffix "copy", "copy 2", …
        if (await fs.exists(dest)) {
            const dot = name.lastIndexOf(".");
            const base = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : "";
            for (let i = 1; ; i++) {
                const candidate = `${targetDir ? `${targetDir}/` : ""}${base} copy${i > 1 ? ` ${i}` : ""}${ext}`;
                if (!(await fs.exists(candidate))) {
                    dest = candidate;
                    break;
                }
            }
        }

        try {
            await this._copyEntry(clip.path, dest, clip.isDir);
            await this._ensureInTree(dest);
            if (clip.cut) {
                if (clip.isDir) await fs.rm(clip.path, { recursive: true });
                else await fs.unlink(clip.path);
                this._removeFromTree(clip.path);
                this._clipboard = null;
            }
        } catch (error) {
            console.error("Paste failed:", error);
        }
    }

    /**
     * Ensure a path exists in the tree, adding it (with ancestors) if needed.
     * @param {string} path clean path
     */
    async _ensureInTree(path) {
        const tree = this._tree;
        if (!tree || !workspace.fs) return;

        let isDirectory;
        try {
            isDirectory = (await workspace.fs.root.stat(`/${path}`)).isDirectory;
        } catch {
            return;
        }

        // Register missing ancestors first.
        const segments = path.split("/");
        for (let i = 1; i < segments.length; i++) {
            const prefix = segments.slice(0, i).join("/");
            if (!this._dirs.has(prefix)) {
                this._dirs.add(prefix);
                this._removeFromTree(prefix);
                tree.add(`${prefix}/`);
            }
        }

        this._removeFromTree(path);
        tree.add(isDirectory ? `${path}/` : path);
    }

    /**
     * Recursively copy a file or directory within the workspace.
     * @param {string} srcPath clean source path
     * @param {string} destPath clean destination path
     * @param {boolean} isDir
     */
    async _copyEntry(srcPath, destPath, isDir) {
        const fs = /** @type {NonNullable<typeof workspace.fs>} */ (workspace.fs);
        if (!isDir) {
            const content = await fs.readFile(srcPath);
            await fs.writeFile(destPath, content);
            return;
        }
        await fs.mkdir(destPath);
        for (const name of await fs.readdir(srcPath)) {
            const srcChild = `${srcPath}/${name}`;
            const destChild = `${destPath}/${name}`;
            if ((await fs.stat(srcChild)).isDirectory) {
                await this._copyEntry(srcChild, destChild, true);
            } else {
                await fs.writeFile(destChild, await fs.readFile(srcChild));
            }
        }
    }

    /**
     * @param {string} path
     * @param {boolean} isDir
     */
    async _delete(path, isDir) {
        const fs = workspace.fs?.root;
        if (!fs) return;
        if (!confirm(`Delete ${path}?`)) return;

        try {
            if (isDir) {
                await fs.rm(path, { recursive: true });
            } else {
                await fs.unlink(path);
            }
            this._removeFromTree(path);
            if (this._clipboard?.path === path) this._clipboard = null;
        } catch (error) {
            console.error("Delete failed:", error);
        }
    }

    /**
     * @param {"file" | "directory"} kind
     */
    async _createEntry(kind) {
        const fs = workspace.fs?.root;
        if (!fs || !this._tree) return;
        const name = prompt(`Name of new ${kind}:`);
        if (!name) return;

        const selected = this._tree.getSelectedPaths().at(-1)?.replace(/\/$/, "");
        const parentDir =
            selected && this._dirs.has(selected)
                ? selected
                : selected && selected.includes("/")
                  ? selected.slice(0, selected.lastIndexOf("/"))
                  : "";
        await this._createEntryIn(kind, parentDir, name);
    }

    /**
     * Create a file/directory inside a specific directory and sync the tree.
     * @param {"file" | "directory"} kind
     * @param {string} parentDir "" for root
     * @param {string} [name] prompts when omitted
     */
    async _createEntryIn(kind, parentDir, name) {
        const fs = workspace.fs?.root;
        if (!fs || !this._tree) return;
        if (name === undefined) {
            const input = prompt(`Name of new ${kind}:`);
            if (!input) return;
            name = input;
        }

        const path = parentDir ? `${parentDir}/${name}` : name;
        try {
            if (kind === "directory") {
                await fs.mkdir(path);
                this._dirs.add(path);
                this._tree.add(`${path}/`);
            } else {
                await fs.writeFile(path, "");
                this._tree.add(path);
            }
        } catch (error) {
            console.error(`Failed to create ${kind}:`, error);
        }
    }
}

customElements.define("file-tree", FileTreePane);

/**
 * Defensive input cleanup for the tree store: if both "dist" and "dist/"
 * somehow end up in the scan result (racing filesystem during the walk),
 * drop the bare entry — the builder registers it as a file and then collides
 * when creating the implicit directory.
 * @param {string[]} paths
 * @returns {string[]}
 */
function sanitizePaths(paths) {
    /** @type {Set<string>} */
    const set = new Set(paths);
    return [...set].filter((p) => !(p.endsWith("/") && set.has(p.slice(0, -1))) && !(!p.endsWith("/") && set.has(`${p}/`)));
}
