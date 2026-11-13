import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "dist", target: "es2022", sourcemap: false },
  server: { host: "127.0.0.1" },
});
