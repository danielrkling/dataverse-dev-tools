import { WebTerminal } from "./terminal.mjs";
// import { createContainer, esbuild, getServerBridge } from "almostnode";
// import { ViteDevServer } from "almostnode";
import { WebFileSystem } from "./fs.mjs";
import { listHandles, saveHandle } from "./handles.mjs";
import { bundle_in_memory } from "./esbuild.mjs";
import { publishWebResources, uploadWebResource } from "./wr.mjs";

// const container = createContainer();

/** @type {WebTerminal}*/
export const terminal = document.querySelector("web-terminal");
terminal._input.disabled = true;

/** @type {WebFileSystem} */
export var fs;

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
 *
 * @param {FileSystemDirectoryHandle} handle
 */
async function loadHandle(handle) {
    saveHandle(handle.name, handle);
    fs = new WebFileSystem(handle);
    window.fs = fs;
    terminal.log(`Loading ${handle.name}`);
    terminal.prompt = handle.name;
    terminal._input.disabled = false;

    try {
        const config = await fs.exists("package.json");
        upload()
    } catch (e) {
        terminal.log(`No Config file found`);
    }
}

terminal.register(async (args, term) => {
    if (args[0] === "upload") {
        if (args[1]) {
            const path = args[1];
            terminal.log(`Uploading ${path}`);
            const wr = await uploadWebResource(`Dev_Tools/${path}`, await fs.readFile(path), "NNSY_Dev_Tools");
            terminal.log(`Uploaded ${path}`);
            await publishWebResources([wr]);
            return `Published ${path}`;
        } else {
            return `Watching ${upload.watch.join(", ")}`;
        }
    }
});

async function upload() {
    const { upload } = await fs
        .readFile("package.json", { encoding: "utf8" })
        .then((r) => JSON.parse(r).webResourceKit);

    const uploadFiles = async (filesToUpload) => {
        if (filesToUpload.length > 0) {
            terminal.log(`Uploading ${filesToUpload.map((f) => f[0])} web resource(s)...`);
            Promise.all(
                filesToUpload.map(([path, content]) =>
                    uploadWebResource(
                        `${upload.prefix}${path.startsWith("/") ? "" : "/"}${path}`,
                        content,
                        upload.solution,
                    ),
                ),
            )
                .then(async (wrs) => {
                    if (upload.refresh === "onUpload") refreshIframe();
                    terminal.log(`Publishing ${wrs.length} web resource(s).`);
                    await publishWebResources(wrs).then(() =>
                        terminal.log(`Successfully published ${wrs.length} web resource(s).`),
                    );
                    if (upload.refresh === "onPublish") refreshIframe();
                })
                .catch((err) => terminal.log("Web resource upload/publish failed:", err));
        }
    };

    for (const watch of upload.watch) {
        const files = await fs.getFilesFromDirectory(watch);
        uploadFiles(Object.entries(files));
        fs.watch(watch, { recursive: true, debounce: 200 }, async (path, type) => {
            if (type === "modified") {
                uploadFiles([[path, await fs.readFile(path)]]);
            }
        });
    }
}

terminal.register(async (args, term) => {
    if (args[0] === "preview") {
        const url = `${location.origin}/WebResources/${args[1] ?? (await fs.readFile("package.json").then((r) => JSON.parse(r).webResourceKit.upload.preview))}`;
        const newWindow = window.open(url);
    }
});

terminal.register(async (args, term) => {
    if (args[0] === "esbuild") {
        const files = await bundle_in_memory(fs, {
            entryPoints: ["./src/app.ts"],
            bundle: true,
            outdir: "dist",
            minify: false,
            format: "esm",
            platform: "browser",
            sourcemap: "inline",
            splitting: false,
            outExtension: {
                ".js": ".mjs",
            },
        });
        return `Built ${files.map((v) => v.path).join(",")}`;
    }
});

terminal.register(async (args, term) => {
    if (args[0] === "run") {
        const code = await fs.readFile(args[1], { encoding: "utf8" });
        return new Function(`
        const module = { exports: {} };
        const exports = module.exports;

        return (async () => {
            ${code}
            return module.exports;
        })();
        `)();
    }
});
