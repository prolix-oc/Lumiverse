import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSettings } from "./settings";
import "./custom-url.css";

const form = document.querySelector<HTMLFormElement>("#frontend-url-form")!;
const input = document.querySelector<HTMLInputElement>("#frontend-url")!;
const error = document.querySelector<HTMLParagraphElement>("#error")!;
const useLocal = document.querySelector<HTMLButtonElement>("#use-local")!;

function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Use an http:// or https:// URL.");
  }
  return url.toString();
}

function showError(message: string): void {
  error.textContent = message;
  error.hidden = false;
}

async function save(value: string | null): Promise<void> {
  await emit("frontend-url-changed", { url: value });
  await getCurrentWindow().close();
}

const settings = await loadSettings();
input.value = settings.customFrontendUrl ?? "";
input.focus();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  error.hidden = true;
  try {
    void save(normalizeUrl(input.value));
  } catch (reason) {
    showError(reason instanceof Error ? reason.message : "Enter a valid URL.");
  }
});

useLocal.addEventListener("click", () => void save(null));
