import { LitElement, html, css } from "lit";
import { bus } from "../services/bus.mjs";
import { workspace } from "../services/workspace.mjs";
import { editorState, ensureMonaco, languageForPath } from "../services/editor.mjs";

/**
 * Center panel: Monaco editor with a tab strip (LitElement).
 *
 * HYBRID rendering: the tab strip and placeholder live in the shadow root
 (real encapsulation), but Monaco's mount point is a plain light-DOM child
 * slotted into the shadow tree. Monaco injects its stylesheet into
 * document.head, which cannot reach inside a shadow root — a light-DOM
 * mount is the only way its styles apply. Keep ALL Monaco-owned DOM inside
 * the light-DOM mount (context menus land there too).
 *
 * LAZY BOOT: the editor (AMD monaco from the CDN) is created on the first
 * file open via _ensureEditor(), not on element connect. Project hydration
 * (background models for IntelliSense) also starts only after that.
 *
 * Listens only to the bus + services:
 * - "editor:open"    -> open file in a tab
 * - "workspace:open" -> reset tabs (editorState.reset handles models)
 * - "fs:changed"     -> reload non-dirty models from disk
 * Ctrl+S saves the active buffer through workspace.fs; buffers also autosave
 * (debounced) shortly after the user stops typing.
 */
/** Autosave debounce: ms of idle after the last keystroke before saving. */
const AUTOSAVE_DELAY_MS = 1500;

export class EditorPane extends LitElement {
    static properties = {
        /** bumped whenever tab/dirty/active state changes, to re-render tabs */
        _tick: { type: Number, state: true },
    };

    static styles = css`
        :host {
            display: flex;
            flex-direction: column;
            min-width: 0;
            min-height: 0;
            overflow: hidden;
            background: #1e1e1e;
            color: #d4d4d4;
            font-family: 'Consolas', 'Monaco', monospace;
        }
        #tabs {
            display: flex;
            overflow-x: auto;
            background: #181818;
            border-bottom: 1px solid #333;
            flex-shrink: 0;
        }
        #tabs::-webkit-scrollbar { height: 6px; }
        .tab {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            cursor: pointer;
            white-space: nowrap;
            font-size: 12px;
            color: #a0a0a0;
            border-right: 1px solid #333;
            user-select: none;
        }
        .tab:hover { background: #232323; }
        .tab.active {
            background: #1e1e1e;
            color: #fff;
            box-shadow: inset 0 2px 0 #569cd6;
        }
        .tab .close {
            all: unset;
            cursor: pointer;
            padding: 0 3px;
            border-radius: 3px;
            line-height: 1;
            display: inline-flex;
        }
        .tab .close:hover { background: #444; }
        .tab.dirty .name::after { content: " ●"; color: #e2c08d; }
        /* The Monaco mount lives in the light DOM (Monaco's styles come from
           document.head) and is slotted into the shadow tree here. */
        ::slotted(.editor-mount) {
            flex: 1;
            min-height: 0;
        }
        #placeholder {
            flex: 1;
            display: grid;
            place-items: center;
            color: #606060;
        }
    `;

    constructor() {
        super();
        this._tick = 0;
        /** @type {import("monaco-editor").editor.IStandaloneCodeEditor | null} */
        this._editor = null;
        /** @type {Map<string, import("monaco-editor").editor.ICodeEditorViewState>} path -> saved view state */
        this._viewStates = new Map();
        /** @type {Map<string, ReturnType<typeof setTimeout>>} path -> pending autosave timer */
        this._autosaveTimers = new Map();
        /** @type {Map<string, number>} path -> ms timestamp of our own last write (echo suppression) */
        this._selfSavedAt = new Map();
        /** @type {(() => void)[]} */
        this._unsubs = [];

        // Light-DOM mount: Monaco's head-injected styles only reach light DOM.
        // Slotted into the shadow tree below the tab strip.
        /** @type {HTMLDivElement} */
        this._mount = Object.assign(document.createElement("div"), { className: "editor-mount" });

        // Light-DOM mount for the git diff view (same styling constraints as
        // _mount). Hidden until a diff is requested from the file tree.
        /** @type {HTMLDivElement} */
        this._diffMount = Object.assign(document.createElement("div"), { className: "editor-mount" });
        Object.assign(this._diffMount.style, { display: "none", flexDirection: "column" });
        /** @type {import("monaco-editor").editor.IStandaloneDiffEditor | null} */
        this._diffEditor = null;
        /** @type {HTMLSpanElement | null} diff header title */
        this._diffTitle = null;
        /** @type {import("monaco-editor").editor.ITextModel | null} ephemeral HEAD-content model */
        this._diffOriginalModel = null;
    }

    render() {
        return html`
            <div id="tabs">
                ${editorState.tabs.map(
                    (tab) => html`
                        <div
                            class="tab ${tab.path === editorState.activePath ? "active" : ""}
                                   ${editorState.dirty.has(tab.path) ? "dirty" : ""}"
                            @click=${() => this.openFile(tab.path)}
                            @auxclick=${(e) => { if (e.button === 1) this._closeTab(tab.path); }}
                        >
                            <span class="name" title=${tab.path}>
                                ${tab.path.split("/").at(-1) ?? tab.path}
                            </span>
                            <button
                                class="close"
                                aria-label=${`Close ${tab.path.split("/").at(-1) ?? tab.path}`}
                                @click=${(e) => { e.stopPropagation(); this._closeTab(tab.path); }}
                            >✕</button>
                        </div>
                    `,
                )}
            </div>
            <slot></slot>
            <div id="placeholder">Open a file from the tree to start editing</div>
        `;
    }

    async connectedCallback() {
        super.connectedCallback();
        this._unsubs.push(
            bus.on("editor:open", (e) => this.openFile(e.detail.path)),
            bus.on("fs:changed", (e) => this._onFsChanged(e.detail)),
            bus.on("workspace:open", () => this._reset()),
        );

        // (Re-)attach the light-DOM Monaco mounts below the tab strip.
        if (this._mount.parentNode !== this) this.appendChild(this._mount);
        if (this._diffMount.parentNode !== this) this.appendChild(this._diffMount);

        this._unsubs.push(
            bus.on("editor:diff", (e) => this.showDiff(e.detail.path, e.detail.original)),
        );

        // Monaco is NOT loaded here — it loads on the first file open.
        document.addEventListener("keydown", (e) => this._onDocumentKeyDown(e));
    }

    /**
     * Create the Monaco editor on first use — nothing Monaco-related is
     * fetched or instantiated until a file is actually opened.
     */
    async _ensureEditor() {
        if (this._editor) return;
        const monaco = await ensureMonaco();
        if (this._editor || !this.isConnected) return;

        this._editor = monaco.editor.create(this._mount, {
            automaticLayout: true,
            theme: "vs-dark",
            fontSize: 13,
            fontFamily: "'Consolas', 'Monaco', monospace",
            minimap: { enabled: false },
            scrollBeyondLastLine: true,
            tabSize: 2,
        });

        // Hydrate project models in the background for cross-file IntelliSense
        // (incl. node_modules .d.ts so package types resolve). Deferred until
        // the first file is actually opened — nothing heavy before that.
        if (workspace.fs) {
            editorState.hydrateProject(workspace.fs).catch((e) => console.error("Hydration failed:", e));
        }

        // Track dirtiness per keystroke and refresh the tab UI. Each change
        // also (re)schedules a debounced autosave for that path.
        this._editor.onDidChangeModelContent(() => {
            const model = this._editor?.getModel();
            if (!model) return;
            const path = /** @type {string} */ (model.uri.path.replace(/^\//, ""));
            if (!editorState.dirty.has(path)) {
                editorState.dirty.add(path);
            }
            this._scheduleAutosave(path);
            this._invalidate();
        });
    }

    /** Global save shortcut (active once the editor exists). */
    _onDocumentKeyDown(e) {
        if (!this._editor) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            this.saveActive();
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        // Flush any pending autosave timers so buffered edits aren't lost.
        for (const path of [...this._autosaveTimers.keys()]) {
            this._clearAutosaveTimer(path);
            this.savePath(path).catch(() => {});
        }
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
        this._diffEditor?.dispose();
        this._diffEditor = null;
        this._diffOriginalModel?.dispose();
        this._diffOriginalModel = null;
        this._editor?.dispose();
        this._editor = null;
    }

    /** Re-render the tab strip (state lives in editorState, not properties). */
    _invalidate() {
        this._tick++;
    }

    /**
     * Open a file in a tab (or focus its existing tab).
     * @param {string} path clean path
     */
    async openFile(path) {
        try {
            // Opening a regular file closes the git diff view.
            this._closeDiff();
            // Lazily boot the editor on the very first file open.
            await this._ensureEditor();
            const model = await editorState.getModel(path);

            if (!editorState.tabs.some((t) => t.path === path)) {
                editorState.tabs.push({ path });
            }
            await this._setActive(path, model);
        } catch (error) {
            console.error(`Failed to open ${path}:`, error);
        }
    }

    /**
     * Show a side-by-side diff of a file: original (git HEAD content, empty
     * for untracked files) vs the live Monaco model (includes unsaved edits).
     * The regular editor stays mounted but hidden; clicking a tab or closing
     * the diff returns to it.
     * @param {string} path clean path
     * @param {string} original HEAD content of the file
     */
    async showDiff(path, original) {
        try {
            const monaco = await ensureMonaco();
            await this._ensureEditor();
            if (!this.isConnected) return;

            if (!this._diffEditor) {
                // Header: file name + close affordance, styled inline because
                // this DOM lives in the light DOM (outside the shadow root).
                const bar = document.createElement("div");
                bar.style.cssText =
                    "display:flex;align-items:center;justify-content:space-between;" +
                    "padding:4px 8px;background:#181818;border-bottom:1px solid #333;" +
                    "font-size:12px;color:#a0a0a0;flex-shrink:0;";
                this._diffTitle = Object.assign(document.createElement("span"), { textContent: path });
                const closeBtn = document.createElement("button");
                closeBtn.textContent = "✕ Close diff";
                closeBtn.style.cssText =
                    "all:unset;cursor:pointer;padding:2px 8px;border-radius:3px;color:#d4d4d4;";
                closeBtn.addEventListener("mouseenter", () => (closeBtn.style.background = "#333"));
                closeBtn.addEventListener("mouseleave", () => (closeBtn.style.background = ""));
                closeBtn.addEventListener("click", () => this._closeDiff());
                bar.append(this._diffTitle, closeBtn);
                const editorDiv = document.createElement("div");
                editorDiv.style.cssText = "flex:1;min-height:0;";
                this._diffMount.style.display = "flex";
                this._diffMount.append(bar, editorDiv);

                this._diffEditor = monaco.editor.createDiffEditor(editorDiv, {
                    automaticLayout: true,
                    theme: "vs-dark",
                    fontSize: 13,
                    fontFamily: "'Consolas', 'Monaco', monospace",
                    readOnly: true,
                    renderSideBySide: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: true,
                });
            } else {
                this._diffMount.style.display = "flex";
                if (this._diffTitle) this._diffTitle.textContent = path;
            }

            // Reuse the file's live model (so local edits show up) and build
            // an ephemeral model for the HEAD content. IMPORTANT: reset the
            // diff editor BEFORE disposing the previous original model —
            // disposing a model still attached to the widget throws
            // "TextModel got disposed before DiffEditorWidget model got reset".
            this._diffEditor?.setModel(null);
            this._diffOriginalModel?.dispose();
            const modified = await editorState.getModel(path);
            this._diffOriginalModel = monaco.editor.createModel(original, languageForPath(path));
            this._diffEditor?.setModel({ original: this._diffOriginalModel, modified });

            // Hide the regular editor while the diff is open.
            this._mount.style.display = "none";
            this.renderRoot.querySelector("#placeholder").style.display = "none";
        } catch (error) {
            console.error(`Failed to show diff for ${path}:`, error);
        }
    }

    /** Close the diff view and restore the regular editor. */
    _closeDiff() {
        if (!this._diffEditor || this._diffMount.style.display === "none") return;
        this._diffMount.style.display = "none";
        this._diffEditor.setModel(null);
        this._diffOriginalModel?.dispose();
        this._diffOriginalModel = null;
        this._mount.style.display = "";
        if (editorState.activePath) {
            this.renderRoot.querySelector("#placeholder").style.display = "none";
        } else {
            this.renderRoot.querySelector("#placeholder").style.display = "";
        }
    }

    /**
     * Switch the editor to a tab's model.
     * @param {string} path
     * @param {import("monaco-editor").editor.ITextModel} [model]
     */
    async _setActive(path, model) {
        if (!this._editor) return;

        if (!model) {
            model = await editorState.getModel(path);
        }

        // Save outgoing view state.
        const previous = editorState.activePath;
        if (previous && previous !== path) {
            this._viewStates.set(previous, /** @type {import("monaco-editor").editor.ICodeEditorViewState} */ (this._editor.saveViewState()));
        }

        editorState.activePath = path;
        this._editor.setModel(model);
        const state = this._viewStates.get(path);
        if (state) this._editor.restoreViewState(state);
        // Deliberately NOT focusing the editor here: opening a file from the
        // tree must keep focus in the sidebar so hotkeys (F2, Delete, Ctrl+B…)
        // keep working immediately, like VS Code. Users click into the editor
        // when they want to type.

        this.renderRoot.querySelector("#placeholder").style.display = "none";
        this._invalidate();
    }

    /**
     * @param {string} path
     */
    _closeTab(path) {
        const index = editorState.tabs.findIndex((t) => t.path === path);
        if (index === -1) return;
        const wasActive = editorState.activePath === path;
        editorState.tabs.splice(index, 1);
        this._viewStates.delete(path);

        // Keep non-active models alive — they power project IntelliSense.
        if (wasActive) {
            const next = editorState.tabs[index - 1] ?? editorState.tabs[0];
            editorState.activePath = null;
            if (next) {
                this.openFile(next.path);
            } else {
                this._editor?.setModel(null);
                this.renderRoot.querySelector("#placeholder").style.display = "";
                this._invalidate();
            }
        } else {
            this._invalidate();
        }
    }

    /** Save a specific buffer to disk (root-relative path). */
    async savePath(path) {
        const fs = workspace.fs?.root;
        if (!fs || !path || !editorState.dirty.has(path)) return;
        const model = editorState.models.get(path);
        if (!model || model.isDisposed()) {
            editorState.dirty.delete(path);
            return;
        }

        // Mark our own write so the fs:changed echo can be recognized and
        // skipped (prevents any save → observer event → reload → save loop).
        this._selfSavedAt.set(path, Date.now());
        await fs.writeFile(`/${path}`, model.getValue());
        editorState.dirty.delete(path);
        this._invalidate();
    }

    /** Save the active buffer to disk (root-relative path). */
    async saveActive() {
        const path = editorState.activePath;
        if (!path) return;
        this._clearAutosaveTimer(path);
        await this.savePath(path);
    }

    /**
     * Autosave: schedule a debounced save for a dirty path (fires after the
     * user stops typing).
     * @param {string} path
     */
    _scheduleAutosave(path) {
        this._clearAutosaveTimer(path);
        this._autosaveTimers.set(
            path,
            setTimeout(() => {
                this._autosaveTimers.delete(path);
                this.savePath(path);
            }, AUTOSAVE_DELAY_MS),
        );
    }

    /**
     * @param {string} path
     */
    _clearAutosaveTimer(path) {
        const t = this._autosaveTimers.get(path);
        if (t !== undefined) {
            clearTimeout(t);
            this._autosaveTimers.delete(path);
        }
    }

    /**
     * External filesystem changes: reload content into non-dirty models so
     * terminal commands (git, esbuild…) stay in sync with the editor.
     * @param {{ path: string, type: string }} detail
     */
    async _onFsChanged({ path, type }) {
        const model = editorState.models.get(path);
        if (!model || model.isDisposed()) return;

        // Ignore the echo of our own save (autosave/Ctrl+S): the observer
        // fires "modified" shortly after writeFile. Without this we'd point-
        // lessly re-read the file; with identical-content reloads it could
        // even ping-pong save → event → edit → save.
        const savedAt = this._selfSavedAt.get(path);
        if (savedAt !== undefined) {
            if (Date.now() - savedAt < 500) return;
            this._selfSavedAt.delete(path);
        }

        if (type === "deleted") {
            // Dispose the model so the TS worker drops it from the project.
            const stale = editorState.models.get(path);
            if (stale && !stale.isDisposed()) {
                stale.dispose();
                editorState.models.delete(path);
            }
            editorState.dirty.delete(path);
            this._closeTabIfOpen(path);
            return;
        }

        if (editorState.dirty.has(path)) return; // never clobber local edits

        const fs = workspace.fs?.root;
        if (!fs || !(await fs.exists(`/${path}`))) {
            const stale = editorState.models.get(path);
            if (stale && !stale.isDisposed()) {
                stale.dispose();
                editorState.models.delete(path);
            }
            editorState.dirty.delete(path);
            this._closeTabIfOpen(path);
            return;
        }

        const content = await fs.readFile(`/${path}`, "utf8");
        if (typeof content === "string" && model.getValue() !== content) {
            model.pushEditOperations(
                [],
                [{ range: model.getFullModelRange(), text: content }],
                () => null,
            );
        }
    }

    /**
     * Close a tab if present (no-op otherwise).
     * @param {string} path
     */
    _closeTabIfOpen(path) {
        if (editorState.tabs.some((t) => t.path === path)) {
            this._closeTab(path);
        }
    }

    /** New workspace opened: drop all tabs and models. */
    _reset() {
        this._closeDiff();
        this._diffMount.style.display = "none";
        editorState.reset();
        this._viewStates.clear();
        this._editor?.setModel(null);
        this.renderRoot.querySelector("#placeholder").style.display = "";
        this._invalidate();
    }
}

customElements.define("editor-pane", EditorPane);
