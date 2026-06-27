import { WebTerminal } from "./terminal.mjs";
import { WebFileSystem } from "./fs.mjs";
import { PluginManager } from "./plugin.mjs";
import { listHandles, saveHandle } from "./handles.mjs";
import { uploadWebResource, publishWebResources } from "./wr.mjs";

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

    try {
        await fs.exists("package.json");
        setupFileWatching();
    } catch (e) {
        terminal.log(`No Config file found`);
    }
}

/** @type {Set<Window>} */
const previewWindows = new Set();

/** @param {Window} win */
export function registerPreviewWindow(win) {
    previewWindows.add(win);
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
        raw = await fs.readFile("package.json", { encoding: "utf8" });
    } catch {
        terminal.info('No package.json found — file watching disabled.');
        return;
    }
    const config = JSON.parse(/** @type {string} */ (raw));
    const upload = config.webResourceKit?.upload;
    if (!upload?.prefix || !upload?.watch) {
        terminal.info('No webResourceKit.upload config found — file watching disabled.');
        return;
    }

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
            await publishWebResources(validWrs);
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
