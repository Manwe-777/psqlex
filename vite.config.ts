import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = `http://127.0.0.1:${process.env.PSQLEX_PORT ?? 7457}`;

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 7458, proxy: { "/api": api, "/mcp": api } },
});
