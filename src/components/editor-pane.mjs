import { LitElement, html, css } from "lit";
import { bus } from "../services/bus.mjs";
import { workspace } from "../services/workspace.mjs";
import { editorState, ensureMonaco } from "../services/editor.mjs";

/**
 * Center panel: Monaco editor with a tab strip (LitElement).
 *
 * NOTE: deliberately rendered in LIGHT DOM (createRenderRoot → this). Monaco
 * injects its stylesheet into document.head, which cannot reach inside a
 * shadow root, so a shadow-DOM host renders the editor unstyled/broken. The
 * <style> block therefore lives in the template like classic custom elements.
 *
 * Listens only to the bus + services:
 * - "editor:open"    -> open file in a tab
 * - "workspace:open" -> reset tabs (editorState.reset handles models)
 * - "fs:changed"     -> reload non-dirty models from disk
 * Ctrl+S saves the active buffer through workspace.fs.
 */
export class EditorPane extends LitElement {
    static properties = {
        /** bumped whenever tab/dirty/active state changes, to re-render tabs */
        _tick: { type: Number, state: true },
    };

    /**
     * Light-DOM styling: renderRoot is `this`, which cannot adopt
     * stylesheets — so the compiled css is hoisted into document.head once
     * (head styles DO apply to light-DOM content, which is exactly why this
     * element is light DOM in the first place).
     */
    static styles = [css`
        editor-pane {
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
        #container {
            flex: 1;
            min-height: 0;
        }
        #placeholder {
            flex: 1;
            display: grid;
            place-items: center;
            color: #606060;
        }
    `];

    /** @type {boolean} guard so the style hoist runs once per page */
    static _stylesHoisted = false;

    constructor() {
        super();
        this._tick = 0;
        /** @type {import("monaco-editor").editor.IStandaloneCodeEditor | null} */
        this._editor = null;
        /** @type {Map<string, import("monaco-editor").editor.ICodeEditorViewState>} path -> saved view state */
        this._viewStates = new Map();
        /** @type {(() => void)[]} */
        this._unsubs = [];
        /** @type {((e: KeyboardEvent) => void) | null} */
        this._onKeyDown = null;
    }

    /** Light DOM: Monaco's head-injected styles must reach the editor. */
    createRenderRoot() {
        return this;
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
                            ><wa-icon name="xmark"></wa-icon></button>
                        </div>
                    `,
                )}
            </div>
            <div id="container"></div>
            <div id="placeholder">Open a file from the tree to start editing</div>
        `;
    }

    async connectedCallback() {
        super.connectedCallback();
        if (!EditorPane._stylesHoisted) {
            const style = document.createElement("style");
            style.textContent = /** @type {any[]} */ (EditorPane.styles).map((s) => s.cssText).join("\n");
            document.head.appendChild(style);
            EditorPane._stylesHoisted = true;
        }
        this._unsubs.push(
            bus.on("editor:open", (e) => this.openFile(e.detail.path)),
            bus.on("fs:changed", (e) => this._onFsChanged(e.detail)),
            bus.on("workspace:open", () => this._reset()),
        );

        const monaco = await ensureMonaco();
        if (this._editor || !this.isConnected) return;

        this._editor = monaco.editor.create(this.renderRoot.querySelector("#container"), {
            automaticLayout: true,
            theme: "vs-dark",
            fontSize: 13,
            fontFamily: "'Consolas', 'Monaco', monospace",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            tabSize: 2,
        });

        // Track dirtiness per keystroke and refresh the tab UI.
        this._editor.onDidChangeModelContent(() => {
            const model = this._editor?.getModel();
            if (!model) return;
            const path = /** @type {string} */ (model.uri.path.replace(/^\//, ""));
            if (!editorState.dirty.has(path)) {
                editorState.dirty.add(path);
            }
            this._invalidate();
        });

        // Ctrl/Cmd+S saves the active buffer.
        this._onKeyDown = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                this.saveActive();
            }
        };
        document.addEventListener("keydown", this._onKeyDown);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
        if (this._onKeyDown) document.removeEventListener("keydown", this._onKeyDown);
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

    /** Save the active buffer to disk (root-relative path). */
    async saveActive() {
        const fs = workspace.fs?.root;
        const path = editorState.activePath;
        const model = this._editor?.getModel();
        if (!fs || !path || !model) return;

        await fs.writeFile(`/${path}`, model.getValue());
        editorState.dirty.delete(path);
        this._invalidate();
    }

    /**
     * External filesystem changes: reload content into non-dirty models so
     * terminal commands (git, esbuild…) stay in sync with the editor.
     * @param {{ path: string, type: string }} detail
     */
    async _onFsChanged({ path, type }) {
        const model = editorState.models.get(path);
        if (!model || model.isDisposed()) return;

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
        editorState.reset();
        this._viewStates.clear();
        this._editor?.setModel(null);
        this.renderRoot.querySelector("#placeholder").style.display = "";
        this._invalidate();

        // Hydrate project models in the background for cross-file IntelliSense.
        if (workspace.fs) {
            editorState.hydrateProject(workspace.fs);
        }
    }
}

customElements.define("editor-pane", EditorPane);
