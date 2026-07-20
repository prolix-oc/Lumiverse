import { resolve } from "node:path";
import { defineConfig } from "vite";

// The tray app is a hidden-window Tauri shell; there is no visible UI.
// clearScreen off + fixed port per Tauri's Vite integration guidance.
//
// __DEFAULT_REPO_DIR__ is the Lumiverse checkout the tray manages when the
// user hasn't picked one in settings. It defaults to the checkout this app
// was built from (desktop/..) and can be overridden at build time with
// LUMIVERSE_REPO_DIR for packaged builds aimed at a different install.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
  define: {
    __DEFAULT_REPO_DIR__: JSON.stringify(
      process.env.LUMIVERSE_REPO_DIR ?? resolve(__dirname, ".."),
    ),
  },
});
