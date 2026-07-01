import { createDebouncer } from "../utils/debounce.mjs";



/** @type {FileSystemObserver | null} */
let rootObserver = null;

const debounceEmit = createDebouncer(150);

async function setupRootObserver() {
  if (rootObserver) {
    rootObserver.disconnect();
    rootObserver = null;
  }

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
    window.fs = fs;
    pm.setFs(fs);
    terminal.log(`Loading ${handle.name}`);
    terminal.prompt = handle.name;

    await setupRootObserver();
    await pm.initPlugins();
}