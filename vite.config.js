import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: [
      // Route all "lit" imports through the CDN-backed shim (src/vendor/lit.mjs)
      // instead of the npm package — see that file for why.
      { find: /^lit$/, replacement: "/src/vendor/lit.mjs" },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      external: ['isomorphic-git', /^https:/],
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  optimizeDeps: {
    exclude: ['isomorphic-git'],
  },
});
