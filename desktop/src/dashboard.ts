/**
 * Dashboard window — reads port from URL params, loads Lumiverse in an iframe.
 * Title bar drag is handled via CSS -webkit-app-region: drag.
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const params = new URLSearchParams(window.location.search);
const port = params.get("port") ?? "7860";
const url = `http://127.0.0.1:${port}`;

// Platform detection — Windows gets custom title bar buttons
const isWindows = navigator.userAgent.includes("Windows");
if (isWindows) {
  document.body.classList.add("platform-windows");
}

// Title bar button handlers
const win = getCurrentWindow();
document.getElementById("btn-close")?.addEventListener("click", () => win.close());
document.getElementById("btn-minimize")?.addEventListener("click", () => win.minimize());
document.getElementById("btn-maximize")?.addEventListener("click", () => win.toggleMaximize());

const container = document.querySelector(".webview-container")!;
const loading = document.getElementById("loading")!;

const iframe = document.createElement("iframe");
iframe.src = url;
iframe.setAttribute("allow", "clipboard-read; clipboard-write");

iframe.addEventListener("load", () => {
  loading.classList.add("hidden");
});

container.appendChild(iframe);

// Fallback: hide loading after 5s even if iframe load event doesn't fire.
setTimeout(() => loading.classList.add("hidden"), 5_000);

// Persist bounds on window move/resize.
let boundsTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSaveBounds() {
  if (boundsTimer) return;
  boundsTimer = setTimeout(async () => {
    boundsTimer = null;
    try {
      const pos = await win.innerPosition();
      const size = await win.innerSize();
      await invoke("save_dashboard_bounds", {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
      });
    } catch {
      // Window may have been closed — ignore.
    }
  }, 500);
}

win.onResized(scheduleSaveBounds);
win.onMoved(scheduleSaveBounds);
