import "@vaadin/split-layout";

/**
 * Application shell: three-pane IDE layout backed by @vaadin/split-layout
 * (CDN import map), with drag-to-edge collapsing and the app's dark theme.
 *
 * Layout:
 *   ┌──────────┬───────────────────┐
 *   │          │      editor       │
 *   │  sidebar ├───────────────────┤
 *   │          │     terminal      │
 *   └──────────┴───────────────────┘
 *
 * Children are placed via slots: slot="sidebar" | "editor" | "terminal".
 * Dragging a splitter past SNAP collapses its panel; dragging it back out
 * reopens the panel at its previous size.
 */
export class IdeApp extends HTMLElement {
    /** Panels snap closed below this many pixels while dragging. */
    static SNAP = 110;

    constructor() {
        super();
        this.attachShadow({ mode: "open" });

        /** Size of each panel before it was collapsed (for restore). */
        this._sidebarRestore = "250px";
        this._terminalRestore = "40%";

        const root = /** @type {ShadowRoot} */ (this.shadowRoot);
        root.innerHTML = `
            <style>
                :host {
                    display: block;
                    height: 100%;
                    --border: #333;
                    --accent: #094771;
                }
                vaadin-split-layout {
                    height: 100%;
                    background: #1e1e1e;
                    color-scheme: dark;
                    /* Correct component custom properties (see src docs) */
                    --vaadin-split-layout-splitter-size: 4px;
                    --vaadin-split-layout-splitter-target-size: 8px;
                    --vaadin-split-layout-splitter-background: var(--border);
                }
                /* Belt-and-braces part styling for hover/drag accent */
                vaadin-split-layout::part(splitter) {
                    transition: background 0.12s;
                }
                vaadin-split-layout::part(splitter):hover,
                vaadin-split-layout::part(splitter):active {
                    background: var(--accent);
                }

                .pane {
                    overflow: hidden;
                    position: relative;
                    min-width: 0;
                    min-height: 0;
                    display: flex;
                    flex-direction: column;
                }
                .pane > ::slotted(*) {
                    flex: 1;
                    min-width: 0;
                    min-height: 0;
                }
                #pane-sidebar {
                    width: var(--sidebar-w, 250px);
                    min-width: 0;
                }
                #pane-editor {
                    flex: 1;
                    min-width: 0;
                    min-height: 0;
                }
                #pane-terminal {
                    height: var(--terminal-h, 40%);
                    min-height: 0;
                }
            </style>
            <vaadin-split-layout id="root">
                <div class="pane" id="pane-sidebar" slot="primary"><slot name="sidebar"></slot></div>
                <vaadin-split-layout orientation="vertical">
                    <div class="pane" id="pane-editor" slot="primary"><slot name="editor"></slot></div>
                    <div class="pane" id="pane-terminal"><slot name="terminal"></slot></div>
                </vaadin-split-layout>
            </vaadin-split-layout>
        `;

        /** @type {any} */ (root.getElementById("root"))
            .addEventListener("splitter-dragend", (/** @type {any} */ e) => this._onDragEnd(e));
    }

    /**
     * After a splitter drag, collapse the panel if it ended up tiny.
     * @param {Event & { target: HTMLElement }} e
     */
    _onDragEnd(e) {
        const splitter = /** @type {HTMLElement} */ (e.target);
        const layout = /** @type {any} */ (splitter.parentElement);
        if (!layout) return;

        // Which panel did this splitter move? Compare against known layouts.
        const rootLayout = /** @type {any} */ (this.shadowRoot?.getElementById("root"));
        if (layout === rootLayout) {
            this._snapSidebar(layout);
        } else {
            this._snapTerminal(/** @type {HTMLElement} */ (layout));
        }
    }

    /**
     * @param {any} layout horizontal root split
     */
    _snapSidebar(layout) {
        const pane = /** @type {HTMLElement} */ (this.shadowRoot?.getElementById("pane-sidebar"));
        if (!pane) return;
        const w = pane.getBoundingClientRect().width;
        if (w < IdeApp.SNAP) {
            pane.style.width = "0px";
        } else {
            // Persist for restore.
            this.style.setProperty("--sidebar-w", `${Math.round(w)}px`);
        }
    }

    /**
     * @param {HTMLElement} layout vertical inner split
     */
    _snapTerminal(layout) {
        const pane = /** @type {HTMLElement} */ (this.shadowRoot?.getElementById("pane-terminal"));
        if (!pane) return;
        const h = pane.getBoundingClientRect().height;
        if (h < IdeApp.SNAP) {
            pane.style.height = "0px";
        } else {
            this.style.setProperty("--terminal-h", `${Math.round(h)}px`);
        }
    }

    /** @param {boolean} [collapsed] force a state instead of toggling */
    toggleSidebar(collapsed) {
        const pane = /** @type {HTMLElement} */ (this.shadowRoot?.getElementById("pane-sidebar"));
        if (!pane) return;
        const shouldCollapse = collapsed ?? pane.getBoundingClientRect().width > 0;
        if (shouldCollapse) {
            this._sidebarRestore = pane.style.width || getComputedStyle(pane).width;
            pane.style.width = "0px";
        } else {
            pane.style.width = this._sidebarRestore || "250px";
        }
    }

    /** @param {boolean} [collapsed] force a state instead of toggling */
    toggleTerminal(collapsed) {
        const pane = /** @type {HTMLElement} */ (this.shadowRoot?.getElementById("pane-terminal"));
        if (!pane) return;
        const shouldCollapse = collapsed ?? pane.getBoundingClientRect().height > 0;
        if (shouldCollapse) {
            this._terminalRestore = pane.style.height || getComputedStyle(pane).height;
            pane.style.height = "0px";
        } else {
            pane.style.height = this._terminalRestore || "40%";
        }
    }
}

customElements.define("ide-app", IdeApp);
