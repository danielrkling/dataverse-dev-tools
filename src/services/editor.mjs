import { scanPaths } from "../utils/scan-paths.mjs";
import { bus } from "./bus.mjs";
import { workspace } from "./workspace.mjs";

const MONACO_VERSION = "0.52.2";
const MONACO_BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs`;

/** Max number of background models hydrated for project-wide IntelliSense. */
const HYDRATION_CAP = 200;

/** @type {Promise<typeof import("monaco-editor")> | null} */
let loading = null;

/**
 * @param {string} src
 * @returns {Promise<void>}
 */
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
}

/**
 * Load Monaco (CDN) once. Safe to call repeatedly.
 *
 * Uses the AMD loader from jsdelivr rather than the esm.sh ESM build: the
 * loader bootstraps the language workers (incl. the TS worker's foreign
 * module loading) correctly in a pure-CDN setup.
 * @returns {Promise<typeof import("monaco-editor")>}
 */
export async function ensureMonaco() {
    if (loading) return loading;
    loading = (async () => {
        await loadScript(`${MONACO_BASE}/loader.js`);
        const amdRequire = /** @type {any} */ (window).require;
        amdRequire.config({ paths: { vs: MONACO_BASE } });
        await new Promise((resolve, reject) => {
            amdRequire(["vs/editor/editor.main"], resolve, reject);
        });
        configureTypeScript(/** @type {any} */ (window).monaco);
        return /** @type {typeof import("monaco-editor")} */ (/** @type {any} */ (window).monaco);
    })();
    return loading;
}

/**
 * Configure the TypeScript language service for project-wide IntelliSense
 * across .ts/.js/.mjs files.
 * @param {typeof import("monaco-editor")} monaco
 */
function configureTypeScript(monaco) {
    const ts = monaco.languages.typescript;
    ts.typescriptDefaults.setCompilerOptions({
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        allowNonTsExtensions: true,
        allowJs: true,
        checkJs: false,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
    });
    // The workspace IS the project; don't warn about missing tsconfig etc.
    ts.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        diagnosticCodesToIgnore: [2792, 2307],
    });
    // Eagerly load defaults so cross-file resolution works immediately.
    ts.typescriptDefaults.setEagerModelSync(true);
}

/**
 * Monaco language id from a file path.
 * @param {string} path
 */
export function languageForPath(path) {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    switch (ext) {
        case "js":
        case "mjs":
        case "cjs":
            return "javascript";
        case "ts":
            return "typescript";
        case "tsx":
            return "typescript";
        case "jsx":
            return "javascript";
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
 * project file, open or not — this is what gives project-level IntelliSense)
 * and the tab/buffer list.
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
        /** @type {boolean} */
        this._hydrating = false;
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

        await ensureMonaco();
        const content = await fs.root.readFile(`/${path}`, "utf8");
        return this._createModel(path, /** @type {string} */ (content));
    }

    /**
     * Internal: actually build a model from file content.
     * @param {string} path
     * @param {string} content
     */
    _createModel(path, content) {
        const m = /** @type {typeof import("monaco-editor")} */ (/** @type {any} */ (window).monaco);
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

    /**
     * Background-hydrate models for source files so the TS worker can resolve
     * imports across the project. Batched to keep the UI responsive.
     * @param {import("./fs.mjs").WebFileSystem} fs
     */
    async hydrateProject(fs) {
        if (this._hydrating || !fs) return;
        this._hydrating = true;
        try {
            await ensureMonaco();
            const { paths } = await scanPaths(fs);
            const sourceFiles = paths.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(p));
            let hydrated = 0;

            for (const path of sourceFiles) {
                if (hydrated >= HYDRATION_CAP) break;
                if (this.models.has(path)) continue;
                try {
                    const content = await fs.root.readFile(`/${path}`, "utf8");
                    if (!this.models.has(path)) {
                        this._createModel(path, /** @type {string} */ (content));
                        hydrated++;
                    }
                } catch {
                    // File vanished mid-scan — skip.
                }
                // Yield to the event loop every file to avoid blocking.
                await new Promise((r) => setTimeout(r, 0));
            }
        } finally {
            this._hydrating = false;
        }
    }
}

export const editorState = new EditorStateImpl();

// Reset editor state whenever a new workspace opens; hydrate after the tree
// has had a chance to render first.
bus.on("workspace:open", () => {
    editorState.reset();
});
