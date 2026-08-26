import "https://ka-f.webawesome.com/webawesome@3.12.0/components/split-panel/split-panel.js";

/**
 * Application shell: three-pane IDE layout backed by Web Awesome's
 * <wa-split-panel> (loaded from the CDN import map), with drag-to-edge
 * collapsing and the app's dark theme.
 *
 * Layout:
 *   ┌──────────┬───────────────────┐
 *   │          │      editor       │
 *   │  sidebar ├───────────────────┤
 *   │          │     terminal      │
 *   └──────────┴───────────────────┘
 *
 * Children are placed via slots: slot="sidebar" | "editor" | "terminal".
 * Dragging a splitter to an edge snaps the panel shut (Web Awesome's built-in
 * `snap` attribute); dragging it back out reopens it. The public
 * toggleSidebar()/toggleTerminal() methods (used by hotkeys) drive the same
 * collapse through each panel's `position` property.
 */
export class IdeApp extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });

        /** Saved (non-collapsed) positions for restore, in percent. */
        this._sidebarRestore = 18; // roughly 250px on a typical wide screen
        this._terminalRestore = 60;

        const root = /** @type {ShadowRoot} */ (this.shadowRoot);
        root.innerHTML = `
            <style>
                :host {
                    display: block;
                    height: 100%;
                    --border: #333;
                    --accent: #094771;
                }
                wa-split-panel {
                    height: 100%;
                    background: #1e1e1e;
                    color-scheme: dark;
                    --divider-width: 4px;
                    --divider-hit-area: 10px;
                    /* Keep the sidebar a fixed-ish size on host resize. */
                    --min: 0px;
                    --max: 100%;
                }
                /* Accent the divider on hover/drag/focus */
                wa-split-panel::part(divider) {
                    transition: background 0.12s;
                    background: var(--border);
                }
                wa-split-panel::part(divider):hover,
                wa-split-panel::part(divider):active,
                wa-split-panel:focus-within::part(divider) {
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
            </style>
            <wa-split-panel id="root" primary="start" position-in-pixels="250" snap="0px" snap-threshold="100">
                <div class="pane" id="pane-sidebar" slot="start"><slot name="sidebar"></slot></div>
                <wa-split-panel slot="end" orientation="vertical" id="inner" primary="start" snap="0% 100%" snap-threshold="100">
                    <div class="pane" id="pane-editor" slot="start"><slot name="editor"></slot></div>
                    <div class="pane" id="pane-terminal" slot="end"><slot name="terminal"></slot></div>
                </wa-split-panel>
            </wa-split-panel>
        `;
    }

    /** @returns {any} root (horizontal) split panel */
    _rootPanel() {
        return /** @type {any} */ (this.shadowRoot?.getElementById("root"));
    }
    /** @returns {any} inner (vertical) split panel */
    _innerPanel() {
        return /** @type {any} */ (this.shadowRoot?.getElementById("inner"));
    }

    /** @param {boolean} [collapsed] force a state instead of toggling */
    toggleSidebar(collapsed) {
        const panel = this._rootPanel();
        if (!panel) return;
        const shouldCollapse = collapsed ?? panel.position > 0;
        if (shouldCollapse) {
            this._sidebarRestore = panel.position || this._sidebarRestore;
            panel.position = 0;
        } else {
            panel.position = this._sidebarRestore;
        }
    }

    /** @param {boolean} [collapsed] force a state instead of toggling */
    toggleTerminal(collapsed) {
        const panel = this._innerPanel();
        if (!panel) return;
        const shouldCollapse = collapsed ?? panel.position < 100;
        if (shouldCollapse) {
            this._terminalRestore = panel.position || this._terminalRestore;
            panel.position = 100;
        } else {
            panel.position = this._terminalRestore;
        }
    }
}

customElements.define("ide-app", IdeApp);
