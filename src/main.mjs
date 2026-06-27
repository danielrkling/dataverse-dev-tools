import { WebTerminal } from "./terminal.mjs";
import { WebFileSystem } from "./fs.mjs";
import { PluginManager } from "./plugin.mjs";
import { listHandles, saveHandle } from "./handles.mjs";
import { uploadWebResource, publishWebResources } from "./wr.mjs";

/** @type {WebTerminal} */
export const terminal = /** @type {WebTerminal} */ (document.querySelector("web-terminal"));
terminal._input.disabled = true;

/** @type {WebFileSystem | undefined} */
export var fs;

/** @type {PluginManager} */
export const pm = new PluginManager({ terminal });

await pm.loadPlugin('builtin', () => import('./commands/builtin.mjs'));
await pm.loadPlugin('fs', () => import('./commands/fs.mjs'));
await pm.loadPlugin('upload', () => import('./commands/upload.mjs'));
await pm.loadPlugin('preview', () => import('./commands/preview.mjs'));
await pm.loadPlugin('esbuild', () => import('./commands/esbuild.mjs'));
await pm.loadPlugin('run', () => import('./commands/run.mjs'));

terminal.setDispatchHandler((args, term) => pm.execute(args, term));

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
    terminal._input.disabled = false;

    try {
        await fs.exists("package.json");
        setupFileWatching();
    } catch (e) {
        terminal.log(`No Config file found`);
    }
}

/**
 * Placeholder for refreshing iframe content.
 * This should be implemented based on the specific iframe structure.
 */
function refreshIframe() {
    // TODO: Implement iframe refresh logic
}

async function setupFileWatching() {
    if (!fs) return;
    const _fs = fs;
    const raw = await _fs.readFile("package.json", { encoding: "utf8" });
    const { upload } = JSON.parse(/** @type {string} */ (raw)).webResourceKit;

    /**
     * @param {Array<[string, string]>} filesToUpload
     */
    const uploadFiles = async (filesToUpload) => {
        if (filesToUpload.length > 0) {
            terminal.log(`Uploading ${filesToUpload.map((f) => f[0])} web resource(s)...`);
            const wrs = await Promise.all(
                filesToUpload.map(([path, content]) =>
                    uploadWebResource(
                        `${upload.prefix}${path.startsWith("/") ? "" : "/"}${path}`,
                        content,
                        upload.solution,
                    ),
                ),
            );
            const validWrs = wrs.filter(/** @return {wr is import('./wr.mjs').WebResource} */ (wr) => wr != null);
            if (upload.refresh === "onUpload") refreshIframe();
            terminal.log(`Publishing ${validWrs.length} web resource(s).`);
            await publishWebResources(validWrs);
            terminal.log(`Successfully published ${validWrs.length} web resource(s).`);
            if (upload.refresh === "onPublish") refreshIframe();
        }
    };

    for (const watch of upload.watch) {
        const files = await _fs.getFilesFromDirectory(watch);
        uploadFiles(Object.entries(files));
        _fs.watch(watch, { recursive: true, debounce: 200 }, async (path, type) => {
            if (type === "modified") {
                const content = await _fs.readFile(path);
                const str = typeof content === 'string' ? content : new TextDecoder().decode(content);
                uploadFiles([[path, str]]);
            }
        });
    }
}
