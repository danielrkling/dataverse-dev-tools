import { WebTerminal } from "./terminal.mjs";
import { WebFileSystem } from "./fs.mjs";
import { PluginManager } from "./plugin.mjs";
import { listHandles, saveHandle } from "./handles.mjs";
import { createDebouncer } from "./utils/debounce.mjs";
import BuiltinPlugin from "./commands/builtin.mjs";
import FsPlugin from "./commands/fs.mjs";
import UploadPlugin from "./commands/upload.mjs";
import PreviewPlugin from "./commands/preview.mjs";
import EsbuildPlugin from "./commands/esbuild.mjs";
import RunPlugin from "./commands/run.mjs";
import InitConfigPlugin from "./commands/init-config.mjs";
import NpmPlugin from "./commands/npm.mjs";
import GitPlugin from "./commands/git.mjs";
import TailwindPlugin from "./commands/tailwind.mjs";
import TscPlugin from "./commands/tsc.mjs";
import FlattenPlugin from "./commands/flatten.mjs";

/** @type {WebTerminal} */
export const terminal = /** @type {WebTerminal} */ (document.querySelector("web-terminal"));

const opfs = await WebFileSystem.fromOPFS('dataverse-dev-tools');
/** @type {WebFileSystem} */
export var fs = opfs;
// @ts-ignore - Expose fs globally for debugging
window.fs = fs;

/** @type {PluginManager} */
export const pm = new PluginManager({ terminal, fs: opfs });

pm.loadPlugin('builtin', BuiltinPlugin);
pm.loadPlugin('fs', FsPlugin);
pm.loadPlugin('upload', UploadPlugin);
pm.loadPlugin('preview', PreviewPlugin);
pm.loadPlugin('esbuild', EsbuildPlugin);
pm.loadPlugin('run', RunPlugin);
pm.loadPlugin('init-config', InitConfigPlugin);
pm.loadPlugin('npm', NpmPlugin);
pm.loadPlugin('git', GitPlugin);
pm.loadPlugin('tailwind', TailwindPlugin);
pm.loadPlugin('tsc', TscPlugin);
pm.loadPlugin('flatten', FlattenPlugin);

terminal.setDispatchHandler((args, term) => pm.execute(args, term));
terminal._input.disabled = false;

/** @type {FileSystemObserver | null} */
let rootObserver = null;

const debounceEmit = createDebouncer(150);

async function setupRootObserver() {
  if (rootObserver) {
    rootObserver.disconnect();
    rootObserver = null;
  }

  // @ts-ignore - FileSystemObserver is experimental
  const observer = new FileSystemObserver((records) => {
    for (const record of records) {
      const path = record.relativePathComponents.join('/');
      const name = record.relativePathComponents.at(-1);
      if (name === 'desktop.ini' || (name && name.endsWith('.crswap'))) continue;

      let type;
      if (record.type === 'appeared' || record.type === 'modified') {
        type = 'modified';
      } else if (record.type === 'disappeared') {
        type = 'deleted';
      } else if (record.type === 'moved') {
        type = 'modified';
      } else {
        continue;
      }

      debounceEmit(path, () => pm.emit('fs:change', { path, type }));
    }
  });

  await observer.observe(fs.rootHandle, { recursive: true });
  rootObserver = observer;
}

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

    await setupRootObserver();
    await pm.initPlugins();
}
