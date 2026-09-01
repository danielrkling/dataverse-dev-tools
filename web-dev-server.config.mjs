/**
 * @web/dev-server config: serve src/ and index.html as-is.
 *
 * Unlike Vite, this does NOT transform, pre-bundle, or resolve bare
 * specifiers — the browser consumes the <script type="importmap"> in
 * index.html directly, so CDN/esm.sh imports work exactly as authored.
 */
export default {
    // Root is the project dir so index.html and src/ resolve naturally.
    rootDir: ".",
    open: true,
    // .mjs must be served with a JS MIME type for module scripts.
    mimeTypes: {
        "**/*.mjs": "text/javascript",
    },
    nodeResolve: false, // leave imports untouched
    preserveSymlinks: true,
};
