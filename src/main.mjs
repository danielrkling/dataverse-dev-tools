import { WebTerminal } from "./terminal.mjs";
import { WebFileSystem } from "./fs.mjs";
import { PluginManager } from "./plugin.mjs";
import { listHandles, saveHandle } from "./handles.mjs";
import { uploadWebResource, publishWebResources } from "./wr.mjs";
import { bundle_in_memory } from "./esbuild.mjs";
import { previewWindows } from "./preview-state.mjs";
import { watchDir, collectContent } from "./tailwind-utils.mjs";

const TW_CDN = 'https://cdn.jsdelivr.net/npm/tailwindcss-iso@1.0.6/dist/browser.js';
/** @type {import('tailwindcss-iso').generateTailwindCSS | null} */
let _generateTailwindCSS = null;
async function getGenerateTailwindCSS() {
  if (!_generateTailwindCSS) {
    const mod = await import(TW_CDN);
    _generateTailwindCSS = mod.generateTailwindCSS;
  }
  return _generateTailwindCSS;
}

/** @type {WebTerminal} */
export const terminal = /** @type {WebTerminal} */ (document.querySelector("web-terminal"));

const opfs = await WebFileSystem.fromOPFS('dataverse-dev-tools');
/** @type {WebFileSystem} */
export var fs = opfs;
// @ts-ignore - Expose fs globally for debugging
window.fs = fs;

/** @type {PluginManager} */
export const pm = new PluginManager({ terminal, fs: opfs });

await pm.loadPlugin('builtin', () => import('./commands/builtin.mjs'));
await pm.loadPlugin('fs', () => import('./commands/fs.mjs'));
await pm.loadPlugin('upload', () => import('./commands/upload.mjs'));
await pm.loadPlugin('preview', () => import('./commands/preview.mjs'));
await pm.loadPlugin('esbuild', () => import('./commands/esbuild.mjs'));
await pm.loadPlugin('run', () => import('./commands/run.mjs'));
await pm.loadPlugin('init-config', () => import('./commands/init-config.mjs'));
await pm.loadPlugin('npm', () => import('./commands/npm.mjs'));
await pm.loadPlugin('git', () => import('./commands/git.mjs'));
await pm.loadPlugin('tailwind', () => import('./commands/tailwind.mjs'));

terminal.setDispatchHandler((args, term) => pm.execute(args, term));
terminal._input.disabled = false;

/**
 * @typedef {import("./handles.mjs").StoredHandle} StoredHandle
 */

async function loadRecentFolders() {
    const recentFolders = await listHandles();
    const elem = document.createElement("div");
    elem.append(`Select a recent folder or open a new one`);

    for (const folder of recentFolders) {
        const button = document.createElement("button");
        button.innerText = `  ${folder.id}`;

        button.onclick = () => {
            loadHandle(folder.handle);
            elem.innerHTML = "";
        };
        elem.appendChild(button);
    }

    const button = document.createElement("button");
    button.innerText = "  Select New Folder";
    button.onclick = async () => {
        // @ts-ignore - showDirectoryPicker is experimental and not in TS DOM types
        const rootHandle = await window.showDirectoryPicker({
            id: "terminal",
            mode: "readwrite",
        });
        loadHandle(rootHandle);
        elem.innerHTML = "";
    };
    elem.appendChild(button);

    terminal.log(elem);
}
loadRecentFolders();

/**
 * @param {FileSystemDirectoryHandle} handle
 */
async function loadHandle(handle) {
    saveHandle(handle.name, handle);
    fs = new WebFileSystem(handle);
    // @ts-ignore - Expose fs globally for debugging
    window.fs = fs;
    pm.setFs(fs);
    terminal.log(`Loading ${handle.name}`);
    terminal.prompt = handle.name;

    if (await fs.exists("dataverse.config.json")) {
        setupFileWatching();
    }
}

function refreshPreviews() {
    for (const win of previewWindows) {
        try {
            win.location.reload();
        } catch {
            previewWindows.delete(win);
        }
    }
}

async function setupFileWatching() {
    let raw;
    try {
        raw = await fs.readFile("dataverse.config.json", { encoding: "utf8" });
    } catch {
        terminal.info('No dataverse.config.json found — file watching disabled.');
        return;
    }
    const config = JSON.parse(/** @type {string} */ (raw));
    const upload = config.upload;

    if (upload?.prefix && upload?.watch) {
        /**
         * @param {Array<[string, string]>} filesToUpload
         */
        const uploadFiles = async (filesToUpload) => {
            if (filesToUpload.length === 0) return;

            /** @type {Map<string, HTMLDivElement>} */
            const lines = new Map();
            for (const [path] of filesToUpload) {
                lines.set(path, terminal.log(`${path} — ○ queued`));
            }

            const uploadResults = await Promise.allSettled(
                filesToUpload.map(async ([path, content]) => {
                    const line = lines.get(path);
                    try {
                        if (line) line.innerHTML = `${path} — ○ uploading...`;
                        const wr = await uploadWebResource(
                            `${upload.prefix}${path.startsWith("/") ? "" : "/"}${path}`,
                            content,
                            upload.solution,
                        );
                        if (line) line.innerHTML = `${path} — <span style="color:#4ec9b0">● uploaded</span>`;
                        return wr;
                    } catch (e) {
                        if (line) line.innerHTML = `${path} — <span style="color:#f48771">✖ failed: ${e.message}</span>`;
                        return undefined;
                    }
                }),
            );

            const validWrs = uploadResults
                .map(r => r.status === 'fulfilled' ? r.value : undefined)
                .filter(/** @return {wr is import('./wr.mjs').WebResource} */ (wr) => wr != null);

            if (validWrs.length === 0) {
                terminal.error('All uploads failed.');
                return;
            }

            if (upload.refresh === "onUpload") refreshPreviews();

            for (const [path] of filesToUpload) {
                const line = lines.get(path);
                if (line && !line.innerHTML.includes('✖')) {
                    line.innerHTML = `${path} — <span style="color:#569cd6">● publishing...</span>`;
                }
            }

            try {
                await publishWebResources(validWrs, upload.solution || undefined);
                for (const [path] of filesToUpload) {
                    const line = lines.get(path);
                    if (line && !line.innerHTML.includes('✖')) {
                        line.innerHTML = `${path} — <span style="color:#569cd6">● published</span>`;
                    }
                }
                if (upload.refresh === "onPublish") refreshPreviews();
            } catch (e) {
                terminal.error(`Publish failed: ${e.message}`);
            }
        };

        for (const watch of upload.watch) {
            const files = await fs.getFilesFromDirectory(watch);
            uploadFiles(Object.entries(files));
            fs.watch(watch, { recursive: true, debounce: 200 }, async (path, type) => {
                if (type === "modified") {
                    const content = await fs.readFile(path);
                    const str = typeof content === 'string' ? content : new TextDecoder().decode(content);
                    uploadFiles([[path, str]]);
                }
            });
        }
    }

    // esbuild watch — rebuild on source file changes
    let esbuildRaw;
    try {
        esbuildRaw = await fs.readFile("esbuild.config.json", { encoding: "utf8" });
    } catch {
        // No esbuild config found — skip esbuild watching
    }

    if (esbuildRaw) {
        const esbuildConfig = JSON.parse(esbuildRaw);
        if (esbuildConfig.watch && Array.isArray(esbuildConfig.watch)) {
            const { watch: watchDirs, ...buildConfig } = esbuildConfig;
            for (const dir of watchDirs) {
                fs.watch(dir, { recursive: true, debounce: 200 }, async (path, type) => {
                    if (type === "modified") {
                        try {
                            const files = await bundle_in_memory(fs, buildConfig);
                            terminal.log(`esbuild rebuilt: ${files.map(f => f.path).join(', ')}`);
                        } catch (e) {
                            terminal.error(`esbuild rebuild failed: ${e.message}`);
                        }
                    }
                });
            }
        }
    }

    // tailwind watch — rebuild tailwind CSS on source changes
    let twRaw;
    try {
        twRaw = await fs.readFile("tailwind.config.json", { encoding: "utf8" });
    } catch {
        // No tailwind config found — skip tailwind watching
    }

    if (twRaw) {
        const twConfig = JSON.parse(twRaw);
        const dirs = /** @type {string[]} */ (twConfig.content || ['.']);
        const extensions = /** @type {string[]|null} */ (twConfig.extensions || null);
        const watchedDirs = new Set();
        for (const entry of dirs) {
            const dir = await watchDir(fs, entry);
            if (!dir || watchedDirs.has(dir)) continue;
            watchedDirs.add(dir);
            fs.watch(dir, { recursive: true, debounce: 300 }, async (path, type) => {
                if (type !== "modified" && type !== "created") return;
                if (extensions) {
                    const dot = path.lastIndexOf('.');
                    if (dot === -1) return;
                    if (!extensions.includes(path.slice(dot + 1))) return;
                }
                try {
                    const generateTailwindCSS = await getGenerateTailwindCSS();
                    terminal.log(`tailwind: ${path} changed — rebuilding...`);
                    const content = await collectContent(fs, dirs, extensions);
                    let css = '';
                    if (twConfig.css) {
                        try { css = await fs.readFile(twConfig.css, { encoding: 'utf8' }); } catch {}
                    }
                    if (twConfig.plugins) {
                        for (const p of twConfig.plugins) {
                            try { css += '\n' + await fs.readFile(p, { encoding: 'utf8' }); } catch {}
                        }
                    }
                    const result = await generateTailwindCSS({
                        content: content || ' ',
                        css,
                        importCSS: twConfig.importCSS || '@import "tailwindcss";',
                    });
                    const outfile = twConfig.outfile || './dist/tailwind.css';
                    await fs.writeFile(outfile, result);
                    terminal.success(`tailwind: rebuilt ${outfile} (${result.length} bytes)`);
                } catch (e) {
                    terminal.error(`tailwind rebuild failed: ${e.message}`);
                }
            }).catch(() => {});
        }
    }
}
