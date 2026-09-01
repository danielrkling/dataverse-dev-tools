import { LitElement, html, css, render as litRender } from "lit";
import { FileTree, prepareFileTreeInput } from "@pierre/trees";
import "@pierre/trees/web-components"; // registers <file-tree-container> + styles
import { bus } from "../services/bus.mjs";
import { workspace, listHandles, deleteHandle } from "../services/workspace.mjs";
import { WebFileSystem } from "../services/fs.mjs";
import { scanPaths } from "../utils/scan-paths.mjs";

/**
 * Sidebar file tree, backed by @pierre/trees (loaded from the CDN import map).
 * LitElement with shadow DOM: the header/recents/loading shell is templated;
 * the @pierre/trees tree itself is mounted imperatively into #mount.
 * No Web Awesome inside the shadow root — the toolbar, buttons, and spinner
 * are own-styled so everything is encapsulated (wa-split-panel stays in the
 * light DOM layout layer, where it belongs).
 *
 * This element is a thin adapter between our services and the library:
 * - "workspace:open"  -> scan workspace.fs and resetPaths()
 * - "fs:changed"      -> incremental tree.add() / tree.remove()
 * - selection/rename/context menu -> fs mutations + bus "editor:open"
 */
export class FileTreePane extends LitElement {
    static properties = {
        _title: { state: true },
        /** @type {{ id: string }[]} recent folders, shown pre-workspace */
        _recents: { state: true },
    };

    constructor() {
        super();
        this._title = "No folder open";
        this._recents = [];
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
        this._emptyElMenu = null;
        /** @type {boolean} true while a drag-move is being applied to the fs */
        this._moving = false;
    }

    static styles = css`
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
        :host header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.25rem 0.5rem;
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
        #mount {
            flex: 1;
            min-height: 0;
        }
        #empty {
            padding: 1rem;
            color: #808080;
        }

        /* --- Toolbar + generic icon button (replaces wa-button/wa-icon) --- */
        .toolbar {
            display: flex;
            align-items: center;
            gap: 2px;
        }
        button {
            font-family: inherit;
            cursor: pointer;
        }
        .icon-btn {
            all: unset;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 22px;
            height: 22px;
            border-radius: 4px;
            color: #a0a0a0;
            cursor: pointer;
            box-sizing: border-box;
        }
        .icon-btn:hover {
            background: #2d2d2d;
            color: #fff;
        }
        .icon-btn svg {
            width: 14px;
            height: 14px;
        }
        .stack {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }
        .flank {
            display: flex;
            align-items: center;
            gap: 0.25rem;
        }
        .recent-item,
        .empty-action {
            all: unset;
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            box-sizing: border-box;
            border-radius: 4px;
            padding: 4px 10px;
            font-size: 12px;
            cursor: pointer;
            max-width: 100%;
        }
        .recent-item > span,
        .recent-item > svg {
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .recent-item {
            background: #2d2d2d;
            color: #d4d4d4;
        }
        .recent-item:hover {
            background: #3d3d3d;
        }
        .recent-item.remove-item {
            padding: 2px 6px;
            background: transparent;
            color: #f48771;
        }
        .recent-item.remove-item:hover {
            background: #3d2d2d;
        }
        .recent-item.remove-item svg {
            width: 10px;
            height: 10px;
        }
        .empty-action {
            border: 1px solid #333;
            background: transparent;
            color: #d4d4d4;
        }
        .empty-action:hover {
            border-color: #569cd6;
            color: #fff;
        }
        .empty-action svg {
            width: 12px;
            height: 12px;
        }
        .empty-action hr {
            border: none;
            border-top: 1px solid #333;
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
        .spinner {
            width: 1.75rem;
            height: 1.75rem;
            border: 2px solid #3d3d3d;
            border-top-color: #569cd6;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    `;

    /** Minimal inline SVG icons (stroke = currentColor) — replaces wa-icon.
     *  Static Lit templates (no unsafe directive needed): the browser's HTML
     *  parser assigns the SVG namespace because the markup sits inside <svg>. */
    static icons = {
        file: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
        "folder-plus": html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="M9 14h6"/></svg>`,
        refresh: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`,
        "folder-open": html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14l1.45-4.34A2 2 0 0 1 9.35 8H21a1 1 0 0 1 .9 1.44l-3.1 5.56a2 2 0 0 1-1.75 1H4a2 2 0 0 1-1.9-2.6L4 5a2 2 0 0 1 2-2h4l2 3h7"/></svg>`,
        xmark: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
        bolt: html`<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 11-14h-7z"/></svg>`,
    };

    /**
     * Inline icon as a Lit template.
     * @param {keyof typeof FileTreePane.icons} name
     */
    icon(name) {
        return FileTreePane.icons[name];
    }

    render() {
        return html`
            <header>
                <span id="title">${this._title}</span>
                <span class="toolbar">
                    <button class="icon-btn" id="new-file" aria-label="New File" title="New File" @click=${() => this._createEntry("file")}>${this.icon("file")}</button>
                    <button class="icon-btn" id="new-folder" aria-label="New Folder" title="New Folder" @click=${() => this._createEntry("directory")}>${this.icon("folder-plus")}</button>
                    <button class="icon-btn" id="refresh" aria-label="Refresh" title="Refresh" @click=${() => this.rebuild()}>${this.icon("refresh")}</button>
                    <button class="icon-btn" id="open-folder" aria-label="Open Folder" title="Open Folder" @click=${() => this.openFolderPicker()}>${this.icon("folder-open")}</button>
                </span>
            </header>
            <div id="empty">
                ${this._recents.length > 0
                    ? html`
                        <div class="stack" style="margin-bottom: 1rem;">
                            ${this._recents.map((folder) => html`
                                <div class="flank">
                                    <button
                                        class="recent-item"
                                        @click=${() => this._openRecent(folder.id)}
                                    ><span>${folder.id}</span></button>
                                    <button
                                        class="recent-item remove-item"
                                        aria-label="Forget ${folder.id}"
                                        title="Forget ${folder.id}"
                                        @click=${(e) => this._forgetRecent(folder.id, e)}
                                    >${this.icon("xmark")}</button>
                                </div>
                            `)}
                            <hr />
                        </div>
                    `
                    : ""}
                <div class="stack" style="margin-top: 0.75rem;">
                    <button
                        class="empty-action"
                        @click=${() => this.openFolderPicker()}
                    >${this.icon("folder-open")} Select New Folder…</button>
                    <button
                        class="empty-action"
                        @click=${() => this._openOPFS()}
                    >${this.icon("bolt")} Use OPFS Workspace</button>
                </div>
            </div>
            <div id="loading"><span class="spinner"></span><span>Loading files…</span></div>
            <div id="mount"></div>
        `;
    }

    firstUpdated() {
        // Context menu on empty tree space (below the rows / between them).
        // Rows are buttons with data-item-path — but they live inside
        // <file-tree-container>'s own shadow root, so e.target is retargeted
        // to the container host by the time this listener runs. Inspect the
        // composed path instead, otherwise every row right-click would ALSO
        // trigger the root menu.
        this._mountEl.addEventListener("contextmenu", (e) => {
            const hitRow = e
                .composedPath()
                .some((el) => el instanceof HTMLElement && el.matches?.("button[data-item-path]"));
            if (hitRow) return; // row menu handles it
            if (!workspace.fs) return;
            e.preventDefault();
            e.stopPropagation();
            this._showEmptySpaceMenu(e.clientX, e.clientY);
        });
    }

    connectedCallback() {
        super.connectedCallback();
        this._unsubs.push(
            bus.on("workspace:open", () => this.rebuild()),
            bus.on("fs:changed", (e) => this._onFsChanged(e.detail)),
        );

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
        super.disconnectedCallback();
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
        this.removeEventListener("keydown", /** @type {any} */ (this._onKeyDown));
        this._tree?.cleanUp();
        this._tree = null;
    }

    // --- Element refs (renderRoot queries; available after first render) ---

    /** @returns {HTMLSpanElement} */
    get _titleEl() { return /** @type {HTMLSpanElement} */ (this.renderRoot.querySelector("#title")); }
    /** @returns {HTMLDivElement} */
    get _emptyEl() { return /** @type {HTMLDivElement} */ (this.renderRoot.querySelector("#empty")); }
    /** @returns {HTMLDivElement} */
    get _mountEl() { return /** @type {HTMLDivElement} */ (this.renderRoot.querySelector("#mount")); }
    /** @returns {HTMLDivElement} */
    get _loadingEl() { return /** @type {HTMLDivElement} */ (this.renderRoot.querySelector("#loading")); }

    /**
     * Load recent folders from storage; rendered by the Lit template.
     */
    async showRecentFolders() {
        this._recents = await listHandles();
        this._emptyEl.style.display = "";
    }

    /**
     * Open a recent folder by id.
     * @param {string} id
     */
    async _openRecent(id) {
        try {
            await workspace.openRecent(id);
        } catch (error) {
            console.error(error);
            // Handle stale/unavailable — fall back to the picker.
            await workspace.openPicker();
        }
    }

    /**
     * Open a named OPFS workspace so multiple projects can coexist (each
     * becomes its own directory under OPFS + its own recent).
     */
    async _openOPFS() {
        // Prompt for a project name so multiple OPFS projects can coexist.
        const raw = prompt("Project name:", "my-project");
        if (!raw) return;
        const dirName = raw.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "my-project";
        try {
            await workspace.open(await WebFileSystem.fromOPFS(dirName));
        } catch (error) {
            console.error("OPFS open failed:", error);
            this.showRecentFolders();
        }
    }

    /**
     * Forget a recent folder (removes the stored handle, keeps files on disk).
     * @param {string} id
     * @param {Event} e
     */
    async _forgetRecent(id, e) {
        e.stopPropagation();
        await deleteHandle(id);
        this._recents = this._recents.filter((f) => f.id !== id);
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

        this._title = fs.rootName; // reactive: rendered by Lit
        this._emptyEl.style.display = "none";
        // Show the spinner while we walk the filesystem (may take a moment on
        // large workspaces). Hidden again once the tree is rendered below.
        this._loadingEl.classList.add("visible");

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
            this._mountEl.innerHTML = "";
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
            this._tree.render({ containerWrapper: this._mountEl });
        }

        // Files are loaded — drop the spinner.
        this._loadingEl.classList.remove("visible");
    }

    /**
     * Open a file in the editor when it gets selected in the tree.
     * @param {readonly string[]} selectedPaths
     */
    _onSelectionChange(selectedPaths) {
        // Skip selection changes while a drag move is in flight — the tree
        // re-emits destinations before the filesystem rename has happened.
        if (this._moving) return;
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
     * Build a styled menu element from entries ("-" = separator), using a
     * Lit template rendered into the container.
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

        const menuTemplate = html`
            ${entries.map((entry) =>
                entry === "-"
                    ? html`<div style="height: 1px; background: #444; margin: 0.25rem 0;"></div>`
                    : html`<button
                        style="all: unset; display: block; padding: 4px 12px; cursor: pointer; color: #d4d4d4;"
                        @mouseenter=${(e) => (e.target.style.background = "#094771")}
                        @mouseleave=${(e) => (e.target.style.background = "")}
                        @click=${() => { /** @type {any} */ (entry).fn?.(); onClose(); }}
                    >${/** @type {any} */ (entry).label}</button>`,
            )}
        `;
        litRender(menuTemplate, menu);
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
        this._emptyElMenu = menu;
    }

    /** Remove the floating empty-space menu, if open. */
    _closeEmptyMenu() {
        if (!this._emptyElMenu) return;
        // @ts-ignore custom cleanup hook
        this._emptyElMenu._dismiss?.();
        this._emptyElMenu.remove();
        this._emptyElMenu = null;
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

        // Suppress editor:open during the move: the tree updates its own
        // store (and re-emits selection for the destinations) BEFORE
        // onDropComplete runs, so the file doesn't exist on disk yet.
        this._moving = true;
        try {
            await this._applyMove(draggedPaths, destDir, fs);
        } finally {
            this._moving = false;
        }
    }

    /**
     * @param {readonly string[]} draggedPaths
     * @param {string} destDir
     * @param {NonNullable<typeof workspace.fs>["root"]} fs
     */
    async _applyMove(draggedPaths, destDir, fs) {
        // The tree reports every selected path, including descendants of
        // other selected paths (e.g. a folder AND a file inside it). The
        // folder move relocates its children — processing the stale child
        // paths afterwards would fail with "source does not exist". So only
        // move the top-most entries; descendants ride along.
        const clean = draggedPaths.map((p) => p.replace(/\/$/, ""));
        const tops = clean.filter((p) => !clean.some((o) => o !== p && p.startsWith(`${o}/`)));

        for (const path of tops) {
            const name = path.split("/").at(-1) ?? path;
            const dest = destDir ? `${destDir}/${name}` : name;
            if (dest === path) continue;
            // Never drop a directory into itself or a descendant.
            if (destDir === path || destDir.startsWith(`${path}/`)) continue;
            try {
                await fs.rename(`/${path}`, `/${dest}`);
                // NOTE: the tree has ALREADY moved this entry in its own
                // store (completeDrag runs before onDropComplete) — do NOT
                // call tree.move() again here.
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

        // The tree moved each selected descendant independently to
        // destDir/<name>, but on the filesystem they actually live under
        // their moved ancestor. Reconcile the store so paths match disk.
        for (const p of clean) {
            if (tops.includes(p)) continue;
            const ancestor = tops.find((t) => p.startsWith(`${t}/`));
            if (!ancestor) continue;
            const name = p.split("/").at(-1) ?? p;
            const treeDest = destDir ? `${destDir}/${name}` : name;
            const actualDest = (destDir ? `${destDir}/` : "") + p.slice(ancestor.length + 1);
            if (treeDest !== actualDest && this._tree?.getItem(treeDest) != null) {
                this._tree.move(treeDest, actualDest);
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
