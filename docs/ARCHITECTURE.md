# Architecture — Dataverse WebResource IDE

A browser-based 3-panel IDE for editing Dataverse web resources: file tree,
editor (Monaco), and a web terminal with git / esbuild / npm-style commands.
All filesystem access goes through the File System Access API (OPFS or a
user-picked directory).

```
┌────────────────────────────────────────────────────────────┐
│ layout: Web Awesome split panels, declared in index.html   │
│  ┌────────────┬─────────────────────────┬────────────────┐ │
│  │ <file-tree>│ <editor-pane> (Monaco)  │ <web-terminal> │ │
│  └────────────┴─────────────────────────┴────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

## Core principle: dependency direction

Panels never talk to each other — they communicate through `services/bus.mjs`
(a tiny `EventTarget` wrapper) and read shared state from services:

```
services/ (fs, workspace, editor, bus)   ← the only shared layer
    ↑                ↑                ↑
file-tree        editor-pane      web-terminal/commands
```

Events on the bus:
- `workspace:open` `{ fs }` — a folder became the active workspace
- `fs:changed` `{ path, type: 'modified'|'deleted'|'moved' }` — external changes
- `editor:open` `{ path }` — something asked the editor to open a file

## Module layout

```
src/
  main.mjs                 # entry: registers elements + commands (index.html loads this)
  services/
    fs.mjs                 # WebFileSystem: File System Access API wrapper (OPFS/picker/handles)
    workspace.mjs          # "which folder is open" singleton + handle persistence (IndexedDB)
    editor.mjs             # editorState: docs, tabs, dirty flags; Monaco model registry + hydration
    bus.mjs                # tiny pub/sub used by everything above
    dataverse.mjs          # Dataverse WebResource REST API client (upload/publish)
  components/
    file-tree.mjs          # sidebar tree (thin adapter over @pierre/trees, CDN import map)
    editor-pane.mjs        # Monaco host + tab strip (light DOM — see note below)
    terminal.mjs           # <web-terminal>: UI element (output, line editing, history);
                           #   delegates command execution to services/commands.mjs
  (layout lives in index.html: Web Awesome wa-split-panel markup + styles;
   no shell element — panels are plain light DOM)
  terminal.mjs             # REMOVED from src/ root — now components/terminal.mjs
  services/
    ...
    commands.mjs           # terminal command registry: argv parsing (&&/&), exec, createCommand()
  commands/                # terminal commands; each is (args, terminal) => Promise
                           #   built with createCommand() from services/commands.mjs
    builtin.mjs            # help/clear/echo
    fs.mjs                 # ls/cat/cd/mv/rm/pwd/stat/mkdir
    esbuild.mjs            # bundle via esbuild-wasm (loaded from CDN at runtime)
    tailwind.mjs           # tailwind CLI emulation (CDN standalone build)
    dataverse.mjs          # upload/preview/publish web resources
    git.mjs, gitlab.mjs    # git via isomorphic-git (vite external, CDN import map)
    npm.mjs, flatten.mjs, history.mjs, open.mjs
  utils/                   # pure helpers: path, json, debounce, history, icons, scan-paths, esbuild
```

Note: `editor-pane` is deliberately rendered in **light DOM** — Monaco injects
its stylesheet into `document.head`, which cannot reach inside a shadow root.

## Editor / TypeScript IntelliSense

`services/editor.mjs` owns one Monaco `ITextModel` per project file (open or
not) so the TS worker sees the whole project:

- On `workspace:open`: `hydrateProject()` materializes models for project
  source first, then `node_modules/` (prioritized: `package.json` → `.d.ts` →
  sources; minified bundles skipped; capped `HYDRATION_CAP`).
- `applyTsConfig()` merges the workspace's `tsconfig.json` compilerOptions
  **over** the base options (setCompilerOptions replaces the whole object —
  rebuilding from just the user's tsconfig would drop the baseUrl/paths that
  make bare specifiers resolve against hydrated node_modules models).
- External `fs:changed` → non-dirty models are reloaded from disk; dirty
  buffers are never clobbered; deletions dispose models and close tabs.

## Loading model

Two-channel dependency loading:

1. **Bundled npm** (Vite): nothing heavy — the app shell is dependency-light.
2. **CDN via import map** (`index.html`): `@pierre/trees`, `@optique/core`,
   `isomorphic-git` (also a Vite external), `picomatch`, `string-argv`,
   `esbuild-wasm`, `zod`, plus runtime CDN imports in
   `commands/tailwind.mjs` / `utils/esbuild.mjs` (tailwind standalone,
   esbuild-wasm) and Monaco itself (jsdelivr AMD loader in
   `services/editor.mjs`).

Keep import-map versions in sync with `package.json` (tests run through Vite
and resolve npm versions; the served app uses the import map).

## Testing

Playwright (`tests/`): fs behavior, esbuild util, editor types hydration,
layout smoke. `npm test` runs them against `npm run dev` on :5173.
