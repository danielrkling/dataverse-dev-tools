import { defineConfig } from "vite";

export default defineConfig({
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
