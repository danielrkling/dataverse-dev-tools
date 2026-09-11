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
- `editor:diff` `{ path, content }` — something asked the editor to open a diff view
- `dataverse:uploaded` / `dataverse:published` `{ files }` — upload pipeline progress (preview listens to these)
- `npm:install` / `npm:uninstall` — package installs started/finished

## Module layout

```
src/
  main.mjs                 # entry: registers elements + commands (index.html loads this)
  services/                # stateful singletons, fs/git plumbing, command registry;
                           #   plain Promise or thin Effect facades over state
    fs.mjs                 # WebFileSystem: File System Access API wrapper (OPFS/picker/handles)
    workspace.mjs          # "which folder is open" singleton + handle persistence (IndexedDB)
    editor.mjs             # editorState: docs, tabs, dirty flags; Monaco model registry + hydration
    bus.mjs                # tiny pub/sub used by everything above
    commands.mjs           # terminal command registry: argv parsing (&&/&), Effect dispatch,
                           #   createCommand(), shared fs helpers (FsError/fsOp/readJsonConfigEffect)
    git-fs.mjs             # isomorphic-git fs adapter + statusLabel (shared, avoids import cycle)
    git-status.mjs         # git status / HEAD content (Effect service + legacy Promise exports)
  effects/                 # Effect Layers, service tags, watch pipeline, typed errors
    services.mjs           # Context tags (WorkspaceFs/TerminalSink/DataverseApi/TerminalUi)
                           #   + commandLayers(term) — the layer composition commands get
    watch-pipeline.mjs     # bus → filter → debounce → semaphore-serialized handler → drain;
                           #   single debounce point, echo suppression; stopped via
                           #   the watcher row's ⏹ button (attachWatchStop)
    logger.mjs             # Effect logging routed to the terminal sink; log-level control
    echo-guard.mjs         # suppresses fs:changed echoes for self-inflicted writes
    dataverse-service.mjs  # Dataverse Web API as an Effect service (timeouts, retries, typed errors)
    terminal-ui.mjs        # TerminalUi service: live (mutable) widgets —
                           #   collapsible status groups (startGroup); passing a
                           #   stable `id` reuses ONE card per watcher and
                           #   re-anchors it to the bottom of the output;
                           #   startWatcher pins a live row in the terminal's
                           #   watcher strip above the input (state dot + detail)
  components/
    file-tree.mjs          # sidebar tree (thin adapter over @pierre/trees, CDN import map)
    editor-pane.mjs        # Monaco host + tab strip (light DOM — see note below)
    terminal.mjs           # <web-terminal>: UI element (output, line editing, history);
                           #   delegates command execution to services/commands.mjs
  (layout lives in index.html: Web Awesome wa-split-panel markup + styles;
   no shell element — panels are plain light DOM)
  commands/                # terminal commands, built with createCommand() from
                           #   services/commands.mjs — all run via `executeEffect`
    builtin.mjs            # help/echo/clear/log-level
    fs.mjs                 # ls/cat/cd/mv/rm/pwd/stat/mkdir
    esbuild.mjs            # bundle via esbuild-wasm (loaded from CDN at runtime)
    tailwind.mjs           # tailwind CLI emulation (CDN standalone build)
    dataverse.mjs          # upload/preview/cache web resources
    git.mjs, gitlab.mjs    # git via isomorphic-git (vite external, CDN import map)
    npm.mjs, flatten.mjs, history.mjs, run.mjs
  utils/                   # pure helpers: path, json, history (re-export shim of
                           #   services/workspace.mjs), scan-paths, esbuild, node-shims
```

> **services/ vs effects/**: `services/` holds stateful singletons and
> fs/git plumbing plus the command registry — plain Promise code, or thin
> Effect facades for compatibility. `effects/` holds Effect Layers, the
> Context service tags, the watch pipeline, and typed errors. Commands are
> built on `executeEffect` and receive their layers via
> `effects/services.mjs` → `commandLayers(term)`; they declare
> requirements and never provide services themselves.

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
