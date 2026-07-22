import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// The tray app is a hidden-window Tauri shell; there is no visible UI.
// clearScreen off + fixed port per Tauri's Vite integration guidance.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        customUrl: fileURLToPath(new URL("./custom-url.html", import.meta.url)),
      },
    },
  },
});
