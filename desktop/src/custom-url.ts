import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  LOCAL_INSTANCE_CONNECTION,
  normalizeRemoteOrigin,
  type InstanceConnection,
  type InstanceConnectionChange,
} from "./instance-connection";
import { resolveLocalServerSource } from "./local-server";
import { loadSettings } from "./settings";
import "./custom-url.css";

const form = document.querySelector<HTMLFormElement>("#frontend-url-form")!;
const input = document.querySelector<HTMLInputElement>("#frontend-url")!;
const error = document.querySelector<HTMLParagraphElement>("#error")!;
const remoteSettings = document.querySelector<HTMLElement>("#remote-settings")!;
const checkoutSettings = document.querySelector<HTMLElement>("#checkout-settings")!;
const checkoutInput = document.querySelector<HTMLInputElement>("#checkout-folder")!;
const browseButton = document.querySelector<HTMLButtonElement>("#browse-checkout")!;
const modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="connection-mode"]')];
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
const saveButton = document.querySelector<HTMLButtonElement>("#save")!;
let rememberedRemote: InstanceConnection | null = null;
let firstRun = false;
let savedBunPath: string | null = null;
let bundledAvailable = false;

function selectedChoice(): "bundled" | "checkout" | "remote" {
  const selected = modeInputs.find((option) => option.checked)?.value;
  return selected === "remote" ? "remote" : selected === "checkout" ? "checkout" : "bundled";
}

async function connectionFromForm(): Promise<InstanceConnectionChange> {
  const choice = selectedChoice();
  if (choice === "bundled") {
    if (!bundledAvailable) throw new Error("This app does not include a built-in server. Choose a checkout or remote instance.");
    return { connection: LOCAL_INSTANCE_CONNECTION, localServerSource: "bundled" };
  }
  if (choice === "checkout") {
    const repoDir = checkoutInput.value.trim();
    if (!repoDir || !(await invoke<boolean>("validate_repo", { path: repoDir }))) {
      throw new Error("Choose a Lumiverse checkout containing scripts/runner.ts.");
    }
    const bunPath = savedBunPath ?? await invoke<string | null>("resolve_bun");
    if (!bunPath) throw new Error("Bun was not found. Install Bun to reuse your checkout, or choose the built-in server.");
    return { connection: LOCAL_INSTANCE_CONNECTION, localServerSource: "checkout", repoDir, bunPath };
  }
  if (!input.value.trim()) throw new Error("Enter the URL of your remote Lumiverse instance.");
  const origin = normalizeRemoteOrigin(input.value);
  return { connection: rememberedRemote?.mode === "remote" && rememberedRemote.origin === origin
    ? rememberedRemote : { mode: "remote", origin } };
}

function showError(message: string): void {
  error.textContent = message;
  error.hidden = false;
}

async function save(selection: InstanceConnectionChange): Promise<void> {
  await emit("instance-connection-changed", selection);
  await getCurrentWindow().close();
}

function updateMode(focusRemote = true): void {
  const choice = selectedChoice();
  const remote = choice === "remote";
  for (const option of modeInputs) {
    option.closest<HTMLElement>("[data-connection-option]")?.toggleAttribute("data-selected", option.checked);
  }
  remoteSettings.hidden = !remote;
  checkoutSettings.hidden = choice !== "checkout";
  checkoutInput.disabled = choice !== "checkout";
  input.disabled = !remote;
  input.required = remote;
  error.hidden = true;
  if (remote && focusRemote) requestAnimationFrame(() => input.focus());
  saveButton.textContent = firstRun
    ? remote ? "Connect to remote instance" : choice === "checkout" ? "Use existing checkout" : "Set up local server"
    : "Save connection";
}

let modeChangedByUser = false;
let remoteEditedByUser = false;
let checkoutEditedByUser = false;
input.addEventListener("input", () => { remoteEditedByUser = true; });
checkoutInput.addEventListener("input", () => { checkoutEditedByUser = true; });
for (const option of modeInputs) {
  option.addEventListener("click", () => {
    modeChangedByUser = true;
  });
  option.addEventListener("change", () => {
    modeChangedByUser = true;
    updateMode();
  });
}
updateMode(false);

async function restoreSavedConnection(): Promise<void> {
  try {
    const settings = await loadSettings();
    bundledAvailable = await invoke<boolean>("bundled_server_available");
    const builtin = modeInputs.find((option) => option.value === "bundled")!;
    builtin.closest<HTMLElement>("[data-connection-option]")!.hidden = !bundledAvailable;
    builtin.disabled = !bundledAvailable;
    const currentChoice = settings.instanceConnection.mode === "remote" ? "remote"
      : resolveLocalServerSource(settings.localServerSource, settings.repoDir, bundledAvailable);
    firstRun = !settings.instanceConnectionConfigured;
    rememberedRemote = settings.savedRemoteConnection;
    savedBunPath = settings.bunPath;
    if (!remoteEditedByUser) input.value = settings.savedRemoteConnection?.origin ?? "";
    if (!checkoutEditedByUser) checkoutInput.value = settings.repoDir ?? "";
    if (firstRun) {
      document.querySelector("h1")!.textContent = "Welcome to Lumiverse";
      document.querySelector(".intro")!.textContent = "Set up a local server, reuse a checkout, or connect to a remote instance.";
    }
    for (const option of modeInputs) {
      const container = option.closest<HTMLElement>("[data-connection-option]");
      const badge = container?.querySelector<HTMLElement>(".current-badge");
      if (badge) badge.hidden = firstRun || option.value !== currentChoice;
    }

    // Do not overwrite a choice made while the store was still loading.
    if (!modeChangedByUser || (selectedChoice() === "bundled" && !bundledAvailable)) {
      for (const option of modeInputs) option.checked = option.value === currentChoice;
    }
    updateMode(false);
    if (currentChoice === "remote" && !modeChangedByUser) input.focus();
  } catch (reason) {
    console.error("Unable to load saved instance connection", reason);
    showError("Saved connection settings could not be loaded. You can still choose and save a connection.");
  } finally {
    saveButton.disabled = false;
  }
}

void restoreSavedConnection();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  saveButton.disabled = true;
  cancelButton.disabled = true;
  try {
    await save(await connectionFromForm());
  } catch (reason) {
    showError(reason instanceof Error ? reason.message : "Enter a valid URL.");
    saveButton.disabled = false;
    cancelButton.disabled = false;
    if (selectedChoice() === "remote") input.focus();
  }
});

browseButton.addEventListener("click", async () => {
  browseButton.disabled = true;
  try {
    const picked = await invoke<string | null>("pick_folder");
    if (picked) {
      checkoutEditedByUser = true;
      checkoutInput.value = picked;
      error.hidden = true;
    }
  } catch (reason) {
    showError(reason instanceof Error ? reason.message : String(reason));
  } finally {
    browseButton.disabled = false;
  }
});

cancelButton.addEventListener("click", () => void getCurrentWindow().close());

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void getCurrentWindow().close();
});
