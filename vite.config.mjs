import { defineConfig } from "vite";

/**
 * The dev server is @web/dev-server (see package.json "dev") — it serves
 * everything as-is and the browser resolves imports via the import map in
 * index.html. Vite is only used for `vite build`.
 *
 * modern-monaco (and its subpath) is CDN-loaded via the import map, so mark
 * it external: the bare specifier stays in the bundle and the browser
 * resolves it at runtime.
 */
export default defineConfig({
    build: {
        rollupOptions: {
            external: [/^modern-monaco($|\/)/],
        },
    },
});
