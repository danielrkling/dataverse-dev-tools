# Architecture — 3-Panel IDE

## Goal

Transform the terminal-only app into a 3-panel IDE:

```
┌──────────────────────────────────────────────────────────┐
│  <ide-app> (CSS grid shell)                              │
│  ┌────────────┬─────────────────────────┬──────────────┐ │
│  │            │                         │              │ │
│  │ <file-tree>│  <editor-pane>          │ <web-terminal>│ │
│  │ (lazy      │  (Monaco, multi-tab)    │ (existing)   │ │
│  │  Pierre-   │                         │              │ │
│  │  style     │                         │              │ │
│  │  tree)     │                         │              │ │
│  └────────────┴─────────────────────────┴──────────────┘ │
└──────────────────────────────────────────────────────────┘
```

## Core principle: dependency direction

Today: `commands → WebTerminal → fs`, and the terminal doubles as the event bus.

New rule — one-way dependencies, no panel knows about another:

```
services/ (fs, workspace, editor-state)   ← the only shared layer
    ↑                ↑               ↑
file-tree.mjs   editor-pane.mjs   web-terminal.mjs
```

## New module layout

```
src/
  main.mjs                 # boots services, registers elements & commands
  services/
    fs.mjs                 # MOVE existing WebFileSystem here (no change to API)
    workspace.mjs          # NEW: "which folder is open" singleton + events
    bus.mjs                # NEW: tiny typed event bus (EventTarget wrapper)
    editor-state.mjs       # NEW: open buffers, dirty flags, active file
  components/
    ide-app.mjs            # grid layout shell, wires panels together
    file-tree.mjs          # sidebar tree
    editor-pane.mjs        # Monaco host + tab strip
  terminal.mjs             # UNCHANGED element, but stops owning fs/events
  commands/                # unchanged — still receive (args, terminal)
```

### `services/workspace.mjs` (the key extraction)

Owns what `open.mjs` currently wires through the terminal:

```js
// singleton
export const workspace = {
  fs: null,
  async open(handle) { /* permission, IndexedDB handle save, FileSystemObserver */ },
};
```

Emits on the bus:
- `workspace:open` `{ fs }` — replaces today's `fs:init`
- `fs:changed` `{ path, type: 'modified'|'deleted'|'moved' }` — replaces `fs:modified`/`fs:deleted` (keep old terminal-dispatched events temporarily for command compat)

The `open` command becomes thin: parse args → `workspace.open()` → log result. The tree and editor react purely to bus events.

### `components/file-tree.mjs`

Sidebar tree backed by **`@pierre/trees`** (loaded from the CDN import map via
esm.sh — no npm install, matching the no-build setup). Our element is only a
thin adapter between services and the library:

- `workspace:open` → scan `workspace.fs` (skipping `node_modules`, `.git`) and
  call `resetPaths()`. The library handles sorting, expansion, and
  virtualization internally.
- `fs:changed` → incremental `tree.add()` / `tree.remove()`; full rescan is
  only for explicit refresh.
- Selection → emits `editor:open { path }` on the bus (never imports editor
  code). Rename uses the library's inline rename (`renaming.onRename` →
  `fs.rename`); delete/context menu via its composition API.

### `components/editor-pane.mjs`

Monaco loaded entirely from CDN — no npm, no bundler:

```html
<script type="importmap">
{
  "imports": {
    "monaco-editor": "https://esm.sh/monaco-editor@0.52.2",
    ...
  }
}
</script>
```

Worker wiring (required, since Monaco spawns web workers):

```js
import * as monaco from "monaco-editor";
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker?worker&url";
// vite resolves this to a URL string without building monaco itself;
// alternative if staying pure-CDN: build worker Blob URLs manually
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "typescript" || label === "javascript")
      return new Worker(tsWorkerUrl, { type: "module" });
    return new Worker(editorWorkerUrl, { type: "module" });
  },
};
```

### Project-level TypeScript IntelliSense

Goal: cross-file completions, go-to-definition and diagnostics across the whole
opened folder — not just the active file.

**How it works:** the Monaco TS worker builds one program from *every* model it
knows about. So project-wide IntelliSense = keep a model per file in the
project, whether or not it's open in a tab.

- `editor-state.mjs` owns a **model registry**: `Map<path, ITextModel>`.
  - On tab open → reuse/create model.
  - In background (lazy): when a `.ts`/`.js` file is first *needed* (imported by
    an open file — discoverable via the tree listing), create its model so the
    worker can resolve it. Optionally hydrate all source files in batches after
    workspace open.
- Models for non-open files live outside the tab strip; tabs only reference
  paths that were explicitly opened by the user.
- Configure once at startup:
  ```js
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    strict: true,
    allowJs: true,
  });
  // avoid "file not in project" noise; we ARE the project
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [2792, 2307], // unresolved modules handled via models
  });
  ```
- Sync rules:
  - User edit → model value updates live → worker revalidates dependents
    automatically.
  - External `fs:changed` → update model content via `model.pushEdits` /
    `setValue` so the worker picks up changes from terminal commands like
    `esbuild`/`git`.
  - `fs:deleted` / rename → dispose model + close tab.
- Type declarations: for npm deps, fetch `.d.ts` from esm.sh (`https://esm.sh/<pkg>/dist/x.d.ts`)
  into `addExtraLib` lazily on first import — same trick VS Code web playgrounds
  use. Keep this behind a small `services/types-cache.mjs` with IndexedDB caching.

Performance guardrails:
- Cap hydrated models (e.g. first ~200 source files); hydrate more on demand.
- Debounce external-change model updates (~150 ms) — matches existing debounce util.

Buffer model:
- Tab = `{ path, viewState, dirty }`; the underlying `ITextModel` lives in the
  registry (see above). Swapping tabs = set editor model + restore view state.
- Save (`Ctrl+S`) → `workspace.fs.writeFile(path, model.getValue())`.
- External change events (`fs:changed`): reload model content if not dirty; flag conflict if dirty.

### Terminal changes (minimal)

- Keep `<web-terminal>` exactly as-is visually and its command registry API.
- Replace internal `this.fs` ownership with reading from `workspace.fs`.
- Re-export bus events so commands like `open.mjs` keep working during migration.

### `main.mjs` boot order

```js
1. import bus, workspace
2. define <ide-app>, <file-tree>, <editor-pane>, <web-terminal>
3. register all commands on the terminal (unchanged list)
4. if a saved workspace handle exists (IndexedDB) → auto-open + permission prompt
```

## Import map additions

| Package | Source |
|---|---|
| `monaco-editor` | `https://esm.sh/monaco-editor@0.52.2` |
| `@pierre/trees` (+ `/web-components`) | `https://esm.sh/@pierre/trees@1.0.0-beta.6` |
| existing deps (`@optique/core`, `isomorphic-git`, etc.) | unchanged |

Ambient types for CDN-only packages live in `src/vendor-types.d.ts` so
`tsc --noEmit` keeps working without installing them.

Vite stays only as dev server + test runner; nothing imports npm-installed packages at runtime except via the import map.

## Migration order

1. Add `services/bus.mjs`, `services/workspace.mjs`; move `fs.mjs` → `services/fs.mjs` (update imports).
2. Rewire `open.mjs` to `workspace.open()`; terminal reads `workspace.fs`.
3. Build `<file-tree>` against bus events (can be tested before editor exists).
4. Add `<editor-pane>` + Monaco CDN wiring + buffer/tab management.
5. Shell `<ide-app>` grid + resizable dividers; move eruda shortcut into shell.

Each step keeps the terminal usable standalone, so tests don't break until step 5.
