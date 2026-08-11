import { listHandles } from "../commands/open.mjs";
import { WebFileSystem } from "../fs.mjs";

/** @type {any} */
let editor = null;

/** @type {any} */
let fileTree = null;

/** @type {Map<string, any>} */
const openModels = new Map();

/** @type {Set<string>} */
const openTabs = new Set();

/** @type {string | null} */
let activePath = null;

const tabsEl = /** @type {HTMLElement} */ (document.getElementById("tabs"));
const tabsLeftBtn = /** @type {HTMLButtonElement} */ (document.getElementById("tabs-left"));
const tabsRightBtn = /** @type {HTMLButtonElement} */ (document.getElementById("tabs-right"));
const treeContainer = /** @type {HTMLElement} */ (document.getElementById("tree-container"));
const monacoContainer = /** @type {HTMLElement} */ (document.getElementById("monaco-container"));
const projectNameEl = /** @type {HTMLElement} */ (document.getElementById("project-name"));

function updateTabScrollButtons() {
    const el = tabsEl;
    tabsLeftBtn.disabled = el.scrollLeft <= 0;
    tabsRightBtn.disabled = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
}

tabsLeftBtn.addEventListener("click", () => tabsEl.scrollBy({ left: -120, behavior: "smooth" }));
tabsRightBtn.addEventListener("click", () => tabsEl.scrollBy({ left: 120, behavior: "smooth" }));
tabsEl.addEventListener("scroll", updateTabScrollButtons);

/** @param {string} path */
function getLanguage(path) {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    /** @type {Record<string, string>} */
    const map = {
        js: "javascript", mjs: "javascript", jsx: "javascript",
        ts: "typescript", tsx: "typescript",
        json: "json", html: "html", htm: "html",
        css: "css", scss: "scss", less: "less",
        md: "markdown", yaml: "yaml", yml: "yaml",
        xml: "xml", svg: "xml",
        py: "python", rb: "ruby", go: "go",
        rs: "rust", java: "java", c: "c",
        cpp: "cpp", h: "c", hpp: "cpp",
        sh: "shell", bash: "shell",
        sql: "sql", graphql: "graphql",
        txt: "plaintext",
    };
    return map[ext] ?? "plaintext";
}

/**
 * @param {import("../fs.mjs").WebFileSystem} fs
 * @param {string} path
 * @returns {Promise<string>}
 */
async function readFile(fs, path) {
    const content = await fs.readFile(path, { encoding: "utf8" });
    return /** @type {string} */ (content);
}

/**
 * Recursively collect file paths from the fs.
 * @param {import("../fs.mjs").WebFileSystem} fs
 * @param {string} [dir=""]
 * @returns {Promise<string[]>}
 */
async function collectPaths(fs, dir = "") {
    /** @type {string[]} */
    const result = [];
    const entries = await fs.readdir(dir);
    for (const name of entries) {
        const path = dir ? `${dir}/${name}` : name;
        try {
            const stat = await fs.stat(path);
            if (stat.isDirectory) {
                result.push(...await collectPaths(fs, path));
            } else {
                result.push(path);
            }
        } catch {
            result.push(path);
        }
    }
    return result;
}

/**
 * @param {string} path
 * @param {any} ed
 */
function openFile(path, ed) {
    if (activePath === path) return;
    if (!ed || !window.monaco) return;

    let model = openModels.get(path);
    if (!model) {
        const lang = getLanguage(path);
        // @ts-expect-error AMD-loaded monaco global
        const uri = monaco.Uri.parse(path);
        // @ts-expect-error AMD-loaded monaco global
        model = monaco.editor.createModel("", lang, uri);
        openModels.set(path, model);

        /** @type {import("../fs.mjs").WebFileSystem} */
        const fs = /** @type {any} */ (window).fs;
        readFile(fs, path).then((content) => {
            if (model && !model.isDisposed()) {
                model.setValue(content);
            }
        });
    }

    ed.setModel(model);
    activePath = path ?? null;
    openTabs.add(path);
    renderTabs();

    const activeTab = tabsEl.querySelector(".tab.active");
    activeTab?.scrollIntoView({ inline: "nearest", block: "nearest" });
    updateTabScrollButtons();
}

function renderTabs() {
    tabsEl.innerHTML = "";
    for (const path of openTabs) {
        const tab = document.createElement("div");
        tab.className = "tab" + (path === activePath ? " active" : "");

        const name = document.createElement("span");
        name.textContent = path.split("/").pop() ?? path;
        tab.appendChild(name);

        const close = document.createElement("span");
        close.className = "close";
        close.textContent = "\u00d7";
        close.onclick = (e) => {
            e.stopPropagation();
            const model = openModels.get(path);
            if (model) model.dispose();
            openModels.delete(path);
            openTabs.delete(path);
            if (activePath === path) {
                activePath = null;
                const remaining = [...openTabs];
                if (remaining.length) {
                    openFile(remaining[remaining.length - 1], editor);
                } else if (editor) {
                    editor.setModel(null);
                }
            }
            renderTabs();
        };
        tab.appendChild(close);

        tab.onclick = () => openFile(path, editor);
        tabsEl.appendChild(tab);
    }
    updateTabScrollButtons();
}

/**
 * Load all code files as Monaco models and configure TS/JS intellisense.
 * @param {any} monaco
 * @param {import("../fs.mjs").WebFileSystem} fs
 */
async function bootstrapWorkspace(monaco, fs) {
    const tsDefaults = monaco.languages.typescript.typescriptDefaults;
    const jsDefaults = monaco.languages.typescript.javascriptDefaults;

    const compilerOptions = {
        target: monaco.languages.typescript.ScriptTarget.ESNext,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        allowNonTsExtensions: true,
        allowJs: true,
        checkJs: true,
        noEmit: true,
        esModuleInterop: true,
        jsx: monaco.languages.typescript.JsxEmit.React,
    };

    tsDefaults.setCompilerOptions(compilerOptions);
    tsDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
    jsDefaults.setCompilerOptions(compilerOptions);
    jsDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });

    const allPaths = await collectPaths(fs);
    const codePaths = allPaths.filter((p) => /\.(ts|tsx|js|mjs|jsx)$/.test(p));

    for (const path of codePaths) {
        if (openModels.has(path)) continue;
        try {
            const content = await readFile(fs, path);
            const lang = getLanguage(path);
            const uri = monaco.Uri.parse(path);
            const model = monaco.editor.createModel(content, lang, uri);
            openModels.set(path, model);
        } catch {
            // skip unreadable files
        }
    }
}

async function init() {
    const handles = await listHandles();
    if (!handles.length) {
        document.body.innerHTML = '<div style="padding:2rem;color:#888">No folder open. Use the <b>open</b> command first.</div>';
        return;
    }

    const handle = handles[0].handle;
    const fs = new WebFileSystem(handle);
    await fs.verifyPermission();

    /** @type {any} */ (window).fs = fs;
    projectNameEl.textContent = fs.rootName;

    const paths = await collectPaths(fs);

    const { FileTree } = await import("https://esm.sh/@pierre/trees@1.0.0-beta.4");

    fileTree = new FileTree({
        paths,
        search: true,
        initialExpansion: "closed",
        /** @param {string[]} selected */
        onSelectionChange: (selected) => {
            if (selected.length === 1) {
                openFile(selected[0], editor);
            }
        },
    });

    fileTree.render({ fileTreeContainer: treeContainer });

    // @ts-expect-error AMD loader global
    require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" } });

    // @ts-expect-error AMD loader global
    require(["vs/editor/editor.main"], async (/** @type {any} */ monacoGlobal) => {
        // @ts-expect-error setting monaco on window
        window.monaco = monacoGlobal;

        monacoGlobal.editor.defineTheme("vs-dark-custom", {
            base: "vs-dark",
            inherit: true,
            rules: [],
            colors: { "editor.background": "#1e1e1e" },
        });

        editor = monacoGlobal.editor.create(monacoContainer, {
            theme: "vs-dark-custom",
            automaticLayout: true,
            fontSize: 14,
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            wordWrap: "on",
        });

        editor.addCommand(monacoGlobal.KeyMod.CtrlCmd | monacoGlobal.KeyCode.KeyS, async () => {
            if (!activePath) return;
            const model = openModels.get(activePath);
            if (!model) return;
            /** @type {import("../fs.mjs").WebFileSystem} */
            const fs = /** @type {any} */ (window).fs;
            await fs.writeFile(activePath, model.getValue());
        });

        await bootstrapWorkspace(monacoGlobal, fs);

        /** @param {CustomEvent} e */
        const onFsModified = (e) => refreshTree(e.detail?.path);
        /** @param {CustomEvent} e */
        const onFsDeleted = (e) => refreshTree(e.detail?.path);

        window.addEventListener("fs:modified", /** @type {any} */ (onFsModified));
        window.addEventListener("fs:deleted", /** @type {any} */ (onFsDeleted));

        setupDivider();
    });
}

/**
 * @param {string} [changedPath]
 */
async function refreshTree(changedPath) {
    if (!fileTree) return;
    /** @type {import("../fs.mjs").WebFileSystem} */
    const fs = /** @type {any} */ (window).fs;
    const paths = await collectPaths(fs);
    fileTree.resetPaths(paths);
}

function setupDivider() {
    const divider = /** @type {HTMLElement} */ (document.getElementById("divider"));
    const sidebar = /** @type {HTMLElement} */ (document.getElementById("sidebar"));
    let dragging = false;

    divider.addEventListener("mousedown", (e) => {
        dragging = true;
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const width = Math.min(Math.max(e.clientX, 180), 400);
        sidebar.style.width = `${width}px`;
    });

    document.addEventListener("mouseup", () => {
        dragging = false;
    });
}

init();
