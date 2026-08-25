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

    /** @type {Record<string, any>} */
    const options = {};
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
        // Lazily pull in type models for any npm packages this file imports.
        void this._hydrateImportsFor(path).catch((e) => console.warn("import hydration failed:", e));
        return model;
    }

    /**
     * Scan a source file's import specifiers and lazily load type models for
     * any bare npm packages it imports.
     * @param {string} path clean root-relative path
     */
    async _hydrateImportsFor(path) {
        if (path.startsWith("node_modules/")) return;
        const model = this.models.get(path);
        if (!model || model.isDisposed()) return;

        for (const spec of extractImportSpecifiers(model.getValue())) {
            const pkg = packageNameFromSpecifier(spec);
            if (pkg) await this._ensurePackageTypes(pkg);
        }
    }

    /**
     * Load a single npm package's type entry into the registry (no-op if
     * already loaded or not installed).
     * @param {string} name package name, e.g. "zod" or "@scope/pkg"
     */
    async _ensurePackageTypes(name) {
        const fs = workspace.fs?.root;
        if (!fs) return;
        const dir = `node_modules/${name}`;

        // Already loaded?
        for (const key of this.models.keys()) {
            if (key.startsWith(`${dir}/`)) return;
        }

        /** @type {any} */
        let pkg;
        try {
            pkg = JSON.parse(/** @type {string} */ (await fs.readFile(`/${dir}/package.json`, "utf8")));
        } catch {
            return; // not installed / unreadable
        }

        /** @type {string[]} candidate type/entry files */
        const candidates = [];
        const typesField = pkg.types ?? pkg.typings;
        if (typesField) candidates.push(joinPosix(dir, typesField));
        if (pkg.main) {
            candidates.push(joinPosix(dir, pkg.main).replace(/\.js$/, ".d.ts"));
            candidates.push(joinPosix(dir, pkg.main));
        }
        candidates.push(
            joinPosix(dir, "index.d.ts"),
            joinPosix(dir, "index.js"),
            `${dir}/package.json`, // last resort: at least exports metadata
        );

        for (const candidate of candidates) {
            if (!/\.(d\.ts|js|mjs|cjs|json)$/.test(candidate)) continue;
            if (await this._tryCreateModelFromDisk(candidate)) break;
        }
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
            if (!this.models.has(path)) this._createModel(path, content);
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
     * Background-hydrate models for source files so the TS worker can resolve
     * imports across the project. Batched to keep the UI responsive.
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
            const sourceFiles = paths.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p));
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
