import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages project site: https://<user>.github.io/dx-sizing-tool/
export default defineConfig({
  base: process.env.VITE_BASE ?? "/dx-sizing-tool/",
  plugins: [react()],
  test: {
    environment: "node",
  },
});
