import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.resolve(projectRoot, "src/renderer"),
  base: "./",
  build: {
    outDir: path.resolve(projectRoot, "dist/renderer"),
    emptyOutDir: false,
  },
});
