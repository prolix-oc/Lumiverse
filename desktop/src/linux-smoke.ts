import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
const input = document.querySelector<HTMLInputElement>("#input")!;
const scroll = document.querySelector<HTMLElement>("#scroll")!;
let typed = false, clicked = false, scrolled = false, complete = false;
async function check() {
  if (!typed || !clicked || !scrolled || complete) return;
  complete = true;
  await invoke("open_external_url", { url: "https://example.invalid/lumiverse-desktop-smoke" });
  await invoke("desktop_smoke_complete");
}
input.addEventListener("input", event => { typed = event.isTrusted && input.value === "lumiverse-smoke"; void check(); });
document.querySelector("#button")!.addEventListener("click", event => { clicked = event.isTrusted; void check(); });
scroll.addEventListener("scroll", () => { scrolled = scroll.scrollTop > 0; void check(); });
input.focus();
// The XTest driver waits for this title so a slow WebKit load cannot lose input.
void getCurrentWindow().setTitle("Lumiverse Desktop Smoke");
