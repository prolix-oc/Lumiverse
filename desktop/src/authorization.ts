import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./custom-url.css";
interface Progress { attemptId: string; origin: string; phase: string; error: string | null; url: string | null }
let active: Progress | null = null;
const query = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const url = query<HTMLTextAreaElement>("authorization-url");
const messages: Record<string,string> = { preparing: "Checking the selected instance…", opening_browser: "Opening your system browser…", callback_pending: "Waiting for desktop authorization in your system browser…", connected: "Desktop authorization completed. You can close this window.", failed: "Desktop authorization failed. Retry to start a new attempt.", cancelled: "Desktop authorization cancelled. Retry when ready." };
async function refresh() {
  try {
    active = await invoke<Progress | null>("remote_authorization_status");
    if (!active) return;
    query("origin").textContent = active.origin;
    query("status").textContent = messages[active.phase] ?? "Waiting for authorization…";
    query("auth-error").textContent = active.error;
    query("auth-error").hidden = !active.error;
    url.value = active.url ?? "";
    query("manual").hidden = !active.url;
  } catch {
    query("status").textContent = "Could not read sign-in progress. Close this window and retry from the tray.";
  }
}
query("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(url.value); }
  catch { url.focus(); url.select(); document.execCommand("copy"); }
});
query("cancel").addEventListener("click", async () => {
  if (active) await invoke("remote_authorization_cancel", { attemptId: active.attemptId });
  await getCurrentWindow().close();
});
query("retry").addEventListener("click", async () => {
  if (active) await invoke("remote_authorization_retry", { attemptId: active.attemptId });
});
void refresh();
const timer = setInterval(() => void refresh(), 400);
window.addEventListener("pagehide", () => { clearInterval(timer); url.value = ""; });
