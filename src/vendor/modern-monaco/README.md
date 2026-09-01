# Vendored: modern-monaco LSP modules (minimal)

Three patched files from `modern-monaco@0.4.2` (~148 KB). Everything else
loads from esm.sh via the import map in `index.html`.

## Why any vendoring is needed

esm.sh cannot currently build modern-monaco's `typescript >= 6.0.0`
dependency (the range resolves to TypeScript 7, and esm.sh's CJS lexer fails
on it, returning HTTP 500). The import lives inside the **typescript
worker** module — and import maps don't apply to workers, and esm.sh's
`?external=` query does not propagate through the relative-import chain into
`worker.mjs` — so the worker's import must be patched directly.

## What changed vs upstream

- `dist/lsp/typescript/worker.mjs`:
  - `"/typescript@>=%206.0.0?target=es2022"` → pinned
    `"https://esm.sh/typescript@5.9.3"`
  - `./libs.mjs`, `../../../cache.mjs`, `../../../editor-worker.mjs` →
    absolute esm.sh URLs (so only the worker itself is local)
- `dist/lsp/typescript/setup.mjs`: `../client.mjs` and `../../../cache.mjs`
  → absolute esm.sh URLs
- `lsp.mjs`: html/css/json setups → absolute esm.sh URLs (only typescript's
  chain is local)

## How it is wired in

`src/services/editor.mjs` merges an import-map entry mapping
`"modern-monaco/lsp"` to this directory's `lsp.mjs` (absolute URL computed at
runtime). The override must be absolute because modern-monaco's `core.mjs`
resolves import-map values against its own esm.sh base URL, and it must live
in the FIRST importmap script on the page (core.mjs only reads that one).

If you bump the modern-monaco version in `index.html`, re-download
`lsp.mjs`, `dist/lsp/typescript/{setup,worker}.mjs` from
`https://esm.sh/modern-monaco@<ver>/es2022/...` and re-apply the patches
above.
