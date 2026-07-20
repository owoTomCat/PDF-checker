import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const builtins = new Set(
  builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
);

export default defineConfig({
  build: {
    ssr: "worker/audit-worker.ts",
    outDir: "dist",
    emptyOutDir: false,
    target: "node22",
    rollupOptions: {
      external(id) {
        return (
          builtins.has(id) ||
          id === "@napi-rs/canvas" ||
          id.startsWith("@napi-rs/canvas-") ||
          id === "pdfjs-dist" ||
          id.startsWith("pdfjs-dist/")
        );
      },
      output: {
        entryFileNames: "audit-worker.mjs",
      },
    },
  },
});
