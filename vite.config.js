import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      external: ['isomorphic-git'],
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  optimizeDeps: {
    exclude: ['isomorphic-git'],
    // Pre-bundle lit so every component shares ONE copy — duplicated Lit
    // instances break adoptedStyleSheets ("Failed to convert value to
    // CSSStyleSheet") and render nothing.
    include: ['lit'],
  },
});
