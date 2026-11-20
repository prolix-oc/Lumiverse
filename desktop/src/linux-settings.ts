import { invoke } from "@tauri-apps/api/core";
import "./custom-url.css";
interface GraphicsSettings { backend: string; mode: string; opaque: boolean }
const query = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const backend = query<HTMLSelectElement>("backend");
const mode = query<HTMLSelectElement>("mode");
const opaque = query<HTMLInputElement>("opaque");
const report = query<HTMLTextAreaElement>("report");
void invoke<{ settings: GraphicsSettings; report: string }>("linux_diagnostics").then(data => {
  backend.value = data.settings.backend || "auto";
  mode.value = data.settings.mode || "default";
  opaque.checked = data.settings.opaque;
  report.value = data.report;
}).catch(() => { query("status").textContent = "Could not load diagnostics."; });
query("graphics-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    await invoke("save_linux_graphics", { settings: { backend: backend.value, mode: mode.value, opaque: opaque.checked } });
    query("status").textContent = "Saved. Quit and reopen Lumiverse Desktop to apply these settings.";
  } catch { query("status").textContent = "Could not save graphics settings."; }
});
query("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(report.value); }
  catch { report.focus(); report.select(); document.execCommand("copy"); }
});
