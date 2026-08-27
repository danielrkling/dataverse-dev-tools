import { scanPaths } from "../utils/scan-paths.mjs";
import { bus } from "./bus.mjs";
import { workspace } from "./workspace.mjs";

const MONACO_VERSION = "0.52.2";
const MONACO_BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs`;

/** Max number of background models hydrated for project-wide IntelliSense. */
const HYDRATION_CAP = 1000;

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
        // Models live at /node_modules/<pkg>/... — let bare specifiers like
        // "zod" resolve against the virtual node_modules tree.
        baseUrl: "/",
        paths: { "*": ["node_modules/*", "node_modules/@types/*"] },
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
 * Resolve a value against a Monaco TS enum (accepts string names like
 * "ESNext" / "NodeJs", case-insensitively).
 * @param {Record<string, any>} enumObj
 * @param {any} value
 */
function pickEnum(enumObj, value) {
    if (value == null) return undefined;
    if (typeof value === "number") return value;
    const key = Object.keys(enumObj).find((k) => k.toLowerCase() === String(value).toLowerCase());
    return key !== undefined ? enumObj[key] : undefined;
}

/**
 * Read /tsconfig.json from the workspace and apply its compilerOptions.
 * Monaco never reads tsconfig on its own — we translate it.
 * @param {(p: string) => Promise<any>} readFile
 */
async function applyTsConfig(readFile) {
    /** @type {any} */
    let config;
    try {
        config = parseJsonc(/** @type {string} */ (await readFile("/tsconfig.json")));
    } catch {
        return; // no tsconfig — keep defaults
    }

    const user = config.compilerOptions ?? {};
    const monaco = /** @type {typeof import("monaco-editor")} */ (/** @type {any} */ (window).monaco);
    const ts = monaco.languages.typescript;

    // IMPORTANT: start from the currently-applied options. Calling
    // setCompilerOptions REPLACES the whole object, so rebuilding from just
    // the user's tsconfig would drop baseUrl/paths/allowNonTsExtensions —
    // i.e. everything that lets bare specifiers resolve against our
    // materialized node_modules models.
    /** @type {Record<string, any>} */
    const options = {
        ...ts.typescriptDefaults.getCompilerOptions(),
    };
    const target = pickEnum(ts.ScriptTarget, user.target);
    if (target !== undefined) options.target = target;
    const moduleKind = pickEnum(ts.ModuleKind, user.module);
    if (moduleKind !== undefined) options.module = moduleKind;
    const moduleRes = pickEnum(ts.ModuleResolutionKind, user.moduleResolution);
    if (moduleRes !== undefined) options.moduleResolution = moduleRes;
    const jsx = pickEnum(ts.JsxEmit, user.jsx);
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

    ts.typescriptDefaults.setCompilerOptions(options);
}

/**
 * Monaco language id from a file path.
 * @param {string} path
 */
export function languageForPath(path) {
    let ext = path.split(".").pop()?.toLowerCase() ?? "";
    // Drop a leading "d." so declaration files (.d.ts/.d.mts/.d.cts) map to the
    // same language as their runtime counterparts — the TS worker only resolves
    // types from typescript/javascript models, so plaintext .d.mts/.d.cts would
    // be ignored.

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

    /**
     * Try to read a file from the workspace root and register its model.
     * @param {string} path clean root-relative path
     * @returns {Promise<boolean>} whether a model was created
     */
    async _tryCreateModelFromDisk(path) {
        try {
            const fs = workspace.fs?.root;
            if (!fs) return false;
            const content = await fs.readFile(`/${path}`, "utf8");
            if (typeof content !== "string") return false;
            if (!this.models.has(path)) this._createModel(path, /** @type {string} */ (content));
            return true;
        } catch {
            return false; // vanished mid-scan or binary
        }
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
     * Create a Monaco model for every code/declaration file in the workspace
     * (plus every package.json) so the TS worker can resolve imports and
     * types across the whole project — including anything under node_modules.
     *
     * We deliberately do NOT special-case package `exports` maps: the worker
     * resolves `import "valibot"` from whatever models exist, so materializing
     * every `.d.ts`/`.ts`/`.js`/etc. file is enough. Project source is loaded
     * first; node_modules files follow, all behind a budget + per-file yields
     * so a large tree can't freeze the editor.
     * @param {import("./fs.mjs").WebFileSystem} fs
     */
    async hydrateProject(fs) {
        if (this._hydrating || !fs) return;
        this._hydrating = true;
        try {
            await ensureMonaco();
            // Apply the project's own tsconfig.json, if present.
            const rfs = fs.root;
            await applyTsConfig((p) => rfs.readFile(p, "utf8"));

            const { paths } = await scanPaths(fs);
            // Prioritize what TS actually needs for type resolution:
            // package.json (exports/main maps) first, then .d.ts/.d.mts/.d.cts
            // declaration files, then runtime sources. Project source always
            // comes before node_modules so the budget can't starve it.
            const rank = (p) =>
                p.endsWith("package.json") ? 0
                : /\.(d\.ts|d\.mts|d\.cts)$/.test(p) ? 1
                : /\.min\.(js|mjs|cjs)$/.test(p) ? 3
                : 2;
            const project = paths.filter((p) => !p.startsWith("node_modules/"));
            const deps = paths
                .filter((p) => p.startsWith("node_modules/"))
                .sort((a, b) => rank(a) - rank(b));

            let loaded = 0;
            for (const path of [...project.sort((a, b) => rank(a) - rank(b)), ...deps]) {
                if (loaded >= HYDRATION_CAP) break;
                if (this.models.has(path)) continue;
                if (!shouldHydrateModel(path)) continue;
                // Minified dist files contribute nothing to type info.
                if (/\.min\.(js|mjs|cjs)$/.test(path)) continue;
                try {
                    const content = await rfs.readFile(`/${path}`, "utf8");
                    if (typeof content === "string" && !this.models.has(path)) {
                        this._createModel(path, content);
                        loaded++;
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

/**
 * Whether a workspace file should become a Monaco model for IntelliSense.
 * We materialize every code/declaration file plus package.json (so the TS
 * worker can read dependency "exports" maps). Non-code assets are skipped.
 * @param {string} path clean root-relative path
 */
export function shouldHydrateModel(path) {
    if (path.endsWith("package.json")) return true;
    return /\.(ts|tsx|js|jsx|mjs|cjs|d\.ts|d\.mts|d\.cts)$/.test(path);
}

export const editorState = new EditorStateImpl();

// Reset editor state whenever a new workspace opens; hydrate after the tree
// has had a chance to render first.
bus.on("workspace:open", () => {
    editorState.reset();
});

/**
 * Join a base directory and a relative entry, POSIX style.
 * @param {string} dir
 * @param {string} rel
 */
function joinPosix(dir, rel) {
    if (rel.startsWith("./")) rel = rel.slice(2);
    if (rel.startsWith("/")) return rel.slice(1);
    return `${dir}/${rel}`;
}

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
