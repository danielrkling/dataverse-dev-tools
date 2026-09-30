/**
 * Shared design tokens + base styles for the app's components.
 * Keeps the dark-theme palette and host layout rules in one place.
 */
import { css, unsafeCSS } from "lit";

/** VS Code–style dark palette used across components (as safe CSS values). */
const hex = (v) => unsafeCSS(v);
export const theme = {
    bg: hex("#1e1e1e"),
    bgPanel: hex("#181818"),
    bgHover: hex("#232323"),
    bgControl: hex("#2d2d2d"),
    bgControlHover: hex("#3d3d3d"),
    border: hex("#333"),
    text: hex("#d4d4d4"),
    textDim: hex("#a0a0a0"),
    textFaint: hex("#808080"),
    textMuted: hex("#606060"),
    accent: hex("#569cd6"),
    error: hex("#f48771"),
    success: hex("#4ec9b0"),
    info: hex("#4fc1ff"),
    warn: hex("#e2c08d"),
};

export const fontFamily = unsafeCSS("'Consolas', 'Monaco', monospace");

/**
 * Base `:host` rules: every pane is a full-height flex column with the
 * dark theme. Components can override individual properties afterwards.
 */
export const hostStyles = css`
    :host {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        box-sizing: border-box;
        background: ${theme.bg};
        color: ${theme.text};
        font-family: ${fontFamily};
    }
`;

/** Shared thin-scrollbar styling (webkit only). */
export const scrollbarStyles = css`
    ::-webkit-scrollbar { width: 8px; height: 6px; }
    ::-webkit-scrollbar-track { background: ${theme.bgControl}; border-radius: 10px; }
    ::-webkit-scrollbar-thumb { background: #555; border-radius: 10px; }
    ::-webkit-scrollbar-thumb:hover { background: #777; }
`;
