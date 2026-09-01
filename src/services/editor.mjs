import { init as initModernMonaco } from "modern-monaco";
import { getMonacoWorkspace } from "./mm-fs.mjs";
import { bus } from "./bus.mjs";
import { workspace } from "./workspace.mjs";

/**
 * Monaco integration via modern-monaco (manual mode):
 * - loads monaco-editor-core + Shiki tokenizer (no MonacoEnvironment/worker
 *   setup, no AMD loader, no CSS loader)
 * - built-in LSPs for HTML, CSS, JS/TS, JSON (import-map aware)
 * - heavy work is deferred: nothing loads until the first file is opened
 */

/** Theme used by the editor (must be a Shiki theme id). */
export const EDITOR_THEME = "github-dark";

/** @type {Promise<typeof import("monaco-editor")> | null} */
let loading = null;

/**
 * Load Monaco once, via modern-monaco. Safe to call repeatedly.
 * @returns {Promise<typeof import("monaco-editor")>}
 */
export async function ensureMonaco() {
    if (loading) return loading;
    loading = (async () => {
        // modern-monaco's LSP module is vendored locally (see
        // src/vendor/modern-monaco/README) because esm.sh cannot currently
        // build its typescript dependency ("typescript >= 6.0.0" resolves to
        // TS 7, which esm.sh fails to compile). The override must be an
        // ABSOLUTE url — core.mjs resolves import-map values against its own
        // esm.sh base — so merge it into the page's existing import map
        // (core.mjs only reads the FIRST importmap script, so a second one
        // injected later would be ignored).
        const mapEl = /** @type {HTMLScriptElement | null} */ (document.querySelector("script[type='importmap']"));
        if (mapEl && !mapEl.textContent?.includes("modern-monaco/lsp")) {
            try {
                const map = JSON.parse(/** @type {string} */ (mapEl.textContent));
                map.imports ??= {};
                map.imports["modern-monaco/lsp"] = new URL("../vendor/modern-monaco/lsp.mjs", import.meta.url).href;
                mapEl.textContent = JSON.stringify(map);
            } catch {
                // import map unreadable — fall back to esm.sh LSP (broken TS worker)
            }
        }

        const compilerOptions = await readTsCompilerOptions();
        const monaco = await initModernMonaco({
            defaultTheme: EDITOR_THEME,
            // Live view of the open project folder — the TS LSP walks this FS
            // for cross-file resolution (no model hydration needed).
            workspace: getMonacoWorkspace(),
            lsp: {
                typescript: {
                    compilerOptions: {
                        allowNonTsExtensions: true,
                        allowJs: true,
                        checkJs: false,
                        esModuleInterop: true,
                        skipLibCheck: true,
                        ...compilerOptions,
                    },
                },
            },
        });
        monacoRef = /** @type {typeof import("monaco-editor")} */ (/** @type {any} */ (monaco));
        return monacoRef;
    })();
    return loading;
}

/** @type {typeof import("monaco-editor") | null} */
let monacoRef = null;

/**
 * The loaded Monaco namespace (only valid after ensureMonaco resolves).
 * @returns {typeof import("monaco-editor")}
 */
function monaco() {
    if (!monacoRef) throw new Error("Monaco not loaded yet — call ensureMonaco() first");
    return monacoRef;
}

// --- tsconfig.json -> compilerOptions -------------------------------------

/**
 * Translate a string enum member ("ESNext", "NodeJs", …) to its numeric
 * value. ts.CompilerOptions wants numbers; tsconfig uses names.
 * @param {Record<string, any>} table string -> number map
 * @param {any} value
 */
function mapEnum(table, value) {
    if (value == null) return undefined;
    if (typeof value === "number") return value;
    return table[String(value).toLowerCase()];
}

const TS_TARGETS = {
    es3: 0, es5: 1, es6: 2, es2015: 2, es2016: 3, es2017: 4, es2018: 5,
    es2019: 6, es2020: 7, es2021: 8, es2022: 9, esnext: 99,
};
const TS_MODULES = {
    none: 0, commonjs: 1, amd: 2, umd: 3, system: 4, es2015: 5, es2020: 6,
    es2022: 7, esnext: 99,
};
const TS_JSX = { none: 0, preserve: 1, "react": 2, "react-jsx": 4, "react-jsxdev": 5, "react-native": 3 };
const TS_MODULE_RESOLUTION = {
    classic: 1, node: 2, node10: 2, node16: 3, nodenext: 99, bundler: 100,
};

/**
 * Read /tsconfig.json from the open workspace and translate its
 * compilerOptions into ts.CompilerOptions (numeric enums).
 * @returns {Promise<Record<string, any>>}
 */
async function readTsCompilerOptions() {
    const fs = workspace.fs?.root;
    if (!fs) return {};
    /** @type {any} */
    let config;
    try {
        config = parseJsonc(/** @type {string} */ (await fs.readFile("/tsconfig.json", "utf8")));
    } catch {
        return {}; // no tsconfig — keep defaults
    }
    const user = config.compilerOptions ?? {};
    /** @type {Record<string, any>} */
    const options = {};
    const target = mapEnum(TS_TARGETS, user.target);
    if (target !== undefined) options.target = target;
    const moduleKind = mapEnum(TS_MODULES, user.module);
    if (moduleKind !== undefined) options.module = moduleKind;
    const moduleRes = mapEnum(TS_MODULE_RESOLUTION, user.moduleResolution);
    if (moduleRes !== undefined) options.moduleResolution = moduleRes;
    const jsx = mapEnum(TS_JSX, user.jsx);
    if (jsx !== undefined) options.jsx = jsx;
    for (const key of [
        "strict", "noImplicitAny", "strictNullChecks", "esModuleInterop",
        "allowJs", "checkJs", "skipLibCheck", "allowSyntheticDefaultImports",
        "resolveJsonModule", "experimentalDecorators",
    ]) {
        if (key in user) options[key] = !!user[key];
    }
    if (user.baseUrl) options.baseUrl = user.baseUrl;
    if (user.paths) options.paths = user.paths;
    return options;
}

/**
 * Strip // and block comments plus trailing commas from JSONC (tsconfig).
 * @param {string} text
 */
function parseJsonc(text) {
    const withoutComments = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
    const withoutTrailing = withoutComments.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(withoutTrailing);
}

/**
 * Monaco language id from a file path.
 * @param {string} path
 */
export function languageForPath(path) {
    let ext = path.split(".").pop()?.toLowerCase() ?? "";
    // Drop a leading "d." so declaration files (.d.ts/.d.mts/.d.cts) map to the
    // same language as their runtime counterparts.

    if (ext.startsWith("d.")) ext = ext.slice(2);
    switch (ext) {
        case "js":
        case "mjs":
        case "cjs":
        case "jsx":
            return "javascript";
        case "ts":
        case "mts":
        case "cts":
        case "tsx":
            return "typescript";
        case "json":
            return "json";
        case "css":
            return "css";
        case "scss":
        case "less":
            return "scss";
        case "html":
        case "htm":
        case "svg":
            return "html";
        case "md":
            return "markdown";
        case "yml":
        case "yaml":
            return "yaml";
        case "xml":
            return "xml";
        case "py":
            return "python";
        default:
            return "plaintext";
    }
}

/**
 * The editor state service: owns the model registry (one ITextModel per
 * opened file, created lazily on demand) and the tab/buffer list.
 *
 * NOTE: unlike the previous monaco-editor AMD setup, there is NO background
 * project hydration — modern-monaco's TS LSP handles module resolution
 * itself, so nothing is loaded until a file is actually opened.
 */
class EditorStateImpl {
    constructor() {
        /** @type {Map<string, import("monaco-editor").editor.ITextModel>} path -> model */
        this.models = new Map();
        /** @type {{path: string, viewState?: object}[]} ordered tabs */
        this.tabs = [];
        /** @type {string | null} */
        this.activePath = null;
        /** @type {Set<string>} paths with unsaved changes */
        this.dirty = new Set();
    }

    /**
     * Get or lazily create the model for a path by reading it from disk.
     * @param {string} path clean path (no trailing slash)
     * @returns {Promise<import("monaco-editor").editor.ITextModel>}
     */
    async getModel(path) {
        const existing = this.models.get(path);
        if (existing && !existing.isDisposed()) return existing;

        const fs = workspace.fs;
        if (!fs) throw new Error(`No workspace open, cannot open ${path}`);

        const m = await ensureMonaco();
        const content = await fs.root.readFile(`/${path}`, "utf8");
        return this._createModel(path, /** @type {string} */ (content));
    }

    /**
     * Internal: actually build a model from file content.
     * @param {string} path
     * @param {string} content
     */
    _createModel(path, content) {
        const m = monaco();
        const model = m.editor.createModel(content, languageForPath(path), m.Uri.file(`/${path}`));
        this.models.set(path, model);
        model.onDidChangeContent(() => {
            this.dirty.add(path);
        });
        return model;
    }

    /** Reset all editor state when a new workspace opens. */
    reset() {
        this.tabs = [];
        this.activePath = null;
        this.dirty.clear();
        for (const model of this.models.values()) model.dispose();
        this.models.clear();
    }
}

export const editorState = new EditorStateImpl();

// Reset editor state whenever a new workspace opens.
bus.on("workspace:open", () => {
    editorState.reset();
});

/**
 * Extract module specifiers from import/export/require statements.
 * @param {string} source
 * @returns {string[]}
 */
export function extractImportSpecifiers(source) {
    /** @type {Set<string>} */
    const found = new Set();
    const patterns = [
        /from\s*["']([^"']+)["']/g,
        /\bimport\s*\(\s*["']([^"']+)["']/g,
        /\brequire\s*\(\s*["']([^"']+)["']/g,
        /\bimport\s+["']([^"']+)["']/g,
    ];
    for (const re of patterns) {
        for (const m of source.matchAll(re)) {
            const spec = m[1];
            if (spec && !spec.startsWith(".") && !spec.startsWith("/") && !/^[a-z]+:/i.test(spec)) {
                found.add(spec);
            }
        }
    }
    return [...found];
}

/**
 * Reduce an import specifier to its package name ("zod", "@scope/pkg").
 * @param {string} specifier
 * @returns {string | null}
 */
export function packageNameFromSpecifier(specifier) {
    if (specifier.startsWith(".") || specifier.startsWith("/") || /^[a-z]+:/i.test(specifier)) {
        return null;
    }
    const clean = specifier.split("?")[0];
    const segments = clean.split("/");
    if (segments[0].startsWith("@") && segments.length >= 2) {
        return `${segments[0]}/${segments[1]}`;
    }
    return segments[0] ?? null;
}
