/**
 * Lumiverse Desktop — experimental Tauri-powered integrated browser and tray.
 *
 * Owns a headless Lumiverse runner (scripts/runner.ts --headless), presents
 * Lumiverse in its native WebView, and keeps server controls available from
 * the tray: status, start/stop, serving stats, updates, and launch options.
 */

import { invoke } from "@tauri-apps/api/core";
import { Image } from "@tauri-apps/api/image";
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { listen } from "@tauri-apps/api/event";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { openUrl } from "@tauri-apps/plugin-opener";
import { RunnerClient, type FullStatus, type ServerState, type UpdateState } from "./runner-client";
import { loadSettings, saveSetting, type TraySettings } from "./settings";
import trayMacIcon from "./assets/tray-mac.png";
import trayWinIcon from "./assets/tray-win.png";

const POLL_INTERVAL_MS = 15_000;
const isMac = navigator.userAgent.includes("Mac");

/**
 * Alerts and pickers go through Rust commands so they never parent to —
 * and thereby reveal — the hidden host window.
 */
function alert(title: string, text: string, error = false): Promise<void> {
  return invoke("alert", { title, message: text, error });
}

// ─── App state ──────────────────────────────────────────────────────────────

const client = new RunnerClient();
let settings: TraySettings;
let repoDir: string | null = null;
let bunPath: string | null = null;
let serverState: ServerState = "stopped";
let externalRunning = false;
let busyMessage: string | null = null;
let port = 7860;
let lastStatus: FullStatus | null = null;
let updateState: UpdateState = { available: false, commitsBehind: 0, latestMessage: "" };
let customFrontendUrl: string | null = null;
let openIntegratedBrowserWhenReady = false;

// ─── Menu items (created once, text/enabled updated in place) ───────────────

let statusItem: MenuItem;
let startStopItem: MenuItem;
let frontendItem: Submenu;
let statsPortItem: MenuItem;
let statsPidItem: MenuItem;
let statsUptimeItem: MenuItem;
let statsBranchItem: MenuItem;
let statsVersionItem: MenuItem;
let checkUpdatesItem: MenuItem;
let applyUpdateItem: MenuItem;
let autoStartItem: CheckMenuItem;
let loginItem: CheckMenuItem;
let openIntegratedBrowserItem: MenuItem;
let openDefaultBrowserItem: MenuItem;
let reloadIntegratedBrowserItem: MenuItem;

function statusText(): string {
  if (busyMessage) return busyMessage;
  if (externalRunning) return "Lumiverse running (external)";
  switch (serverState) {
    case "running":
      return "Lumiverse running";
    case "starting":
      return "Lumiverse starting…";
    case "stopping":
      return "Lumiverse stopping…";
    case "crashed":
      return "Lumiverse crashed";
    default:
      return "Lumiverse stopped";
  }
}

function formatUptime(startedAt: number | null): string {
  if (!startedAt) return "—";
  const totalMinutes = Math.floor((Date.now() - startedAt) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function updateFrontendMenuText(): Promise<void> {
  const running = serverState === "running" || externalRunning;
  const frontendAvailable = running || customFrontendUrl !== null;
  const visible = await invoke<boolean>("frontend_visible").catch(() => false);
  const exists = await invoke<boolean>("frontend_exists").catch(() => false);

  await frontendItem.setText(visible ? "Close Lumiverse" : "Open Lumiverse");

  await openIntegratedBrowserItem.setEnabled(frontendAvailable);
  await openDefaultBrowserItem.setEnabled(frontendAvailable);
  await reloadIntegratedBrowserItem.setEnabled(frontendAvailable && exists);
}

function frontendUrl(): string {
  return customFrontendUrl ?? `http://127.0.0.1:${port}`;
}

async function updateMenu(): Promise<void> {
  const running = serverState === "running";
  const transitioning = serverState === "starting" || serverState === "stopping" || busyMessage !== null;

  await statusItem.setText(statusText());

  if (externalRunning) {
    await startStopItem.setText("Stop Server");
    await startStopItem.setEnabled(false);
  } else {
    await startStopItem.setText(running || serverState === "starting" ? "Stop Server" : "Start Server");
    await startStopItem.setEnabled(!transitioning || serverState === "starting");
  }

  await updateFrontendMenuText();

  await statsPortItem.setText(`Port: ${port}`);
  await statsPidItem.setText(`PID: ${lastStatus?.pid ?? "—"}`);
  await statsUptimeItem.setText(`Uptime: ${running ? formatUptime(lastStatus?.startedAt ?? null) : "—"}`);
  await statsBranchItem.setText(`Branch: ${lastStatus?.branch ?? "—"}`);
  await statsVersionItem.setText(`Version: ${lastStatus?.version ?? "—"}`);

  await checkUpdatesItem.setEnabled(!busyMessage && !externalRunning);
  if (updateState.available) {
    await applyUpdateItem.setText(`Apply Update (${updateState.commitsBehind} behind)`);
    await applyUpdateItem.setEnabled(!busyMessage && !externalRunning);
  } else {
    await applyUpdateItem.setText("Apply Update");
    await applyUpdateItem.setEnabled(false);
  }
}

// ─── Runner orchestration ───────────────────────────────────────────────────

async function ensureRunner(): Promise<void> {
  if (await client.alive()) return;
  if (!repoDir) {
    throw new Error("No Lumiverse folder configured. Use “Set Lumiverse Folder…” first.");
  }
  if (!bunPath) {
    throw new Error("Bun was not found. Install it from https://bun.sh and relaunch.");
  }
  await client.spawn(repoDir, bunPath);
}

async function refreshStatus(): Promise<void> {
  if (!(await client.alive())) return;
  try {
    lastStatus = await client.fullStatus();
    serverState = lastStatus.state;
    port = lastStatus.port;
    updateState = {
      available: lastStatus.updateAvailable,
      commitsBehind: lastStatus.commitsBehind,
      latestMessage: lastStatus.latestUpdateMessage,
    };
  } catch {
    // Runner busy or mid-restart — keep last known state.
  }
}

async function startServer(): Promise<void> {
  await ensureRunner();
  // The runner acknowledges this request while the server is still starting.
  // Defer opening the native WebView until its `running` state notification.
  openIntegratedBrowserWhenReady = true;
  serverState = "starting";
  await updateMenu();
  await client.request("start-server");
  await refreshStatus();
  if (openIntegratedBrowserWhenReady && lastStatus?.state === "running") {
    openIntegratedBrowserWhenReady = false;
    await invoke("show_frontend", { port, customUrl: customFrontendUrl });
  }
  await updateMenu();
}

async function stopServer(): Promise<void> {
  serverState = "stopping";
  await updateMenu();
  await client.request("stop-server", undefined, 30_000);
  await refreshStatus();
  await updateMenu();
}

async function checkForUpdates(interactive: boolean): Promise<void> {
  await ensureRunner();
  const result = await client.request<UpdateState>("check-updates", undefined, 90_000);
  updateState = result;
  await updateMenu();
  if (interactive) {
    if (result.available) {
      await alert(
        "Lumiverse update available",
        `${result.commitsBehind} commit(s) behind.\nLatest: ${result.latestMessage}`,
      );
    } else {
      await alert("Lumiverse", "Lumiverse is up to date.");
    }
  }
}

async function applyUpdate(): Promise<void> {
  await ensureRunner();
  busyMessage = "Applying update…";
  await updateMenu();
  try {
    await client.request("apply-update", undefined, 60_000);
  } catch (err) {
    busyMessage = null;
    await updateMenu();
    throw err;
  }
}

/**
 * Stop the runner (and its server) gracefully; force-kill the whole
 * process tree if the handshake times out.
 */
async function shutdownRunner(): Promise<void> {
  if (!(await client.alive())) return;
  try {
    const exited = client.waitForExit(15_000);
    await client.request("quit", undefined, 15_000).catch(() => {});
    await exited;
  } catch {
    await client.kill();
  }
}

async function quit(): Promise<void> {
  if (await client.alive()) {
    busyMessage = "Shutting down…";
    await updateMenu();
    await shutdownRunner();
  }
  await invoke("quit_app");
}

/** Detect a server started outside the tray (start.sh / terminal). */
async function detectExternalServer(): Promise<void> {
  const runnerOwned = await client.alive();
  if (runnerOwned && serverState !== "stopped" && serverState !== "crashed") {
    externalRunning = false;
    return;
  }
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      method: "HEAD",
      mode: "no-cors",
      signal: AbortSignal.timeout(3_000),
    });
    externalRunning = true;
  } catch {
    externalRunning = false;
  }
}

// ─── Action wrapper ─────────────────────────────────────────────────────────

function action(fn: () => Promise<void>): () => void {
  return () => {
    fn().catch(async (err) => {
      busyMessage = null;
      await updateMenu();
      await alert("Lumiverse", err instanceof Error ? err.message : String(err), true);
    });
  };
}

// ─── Tray construction ──────────────────────────────────────────────────────

async function loadTrayImage(): Promise<Image> {
  const url = isMac ? trayMacIcon : trayWinIcon;
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return Image.fromBytes(bytes);
}

async function buildTray(): Promise<void> {
  statusItem = await MenuItem.new({ text: statusText(), enabled: false });
  startStopItem = await MenuItem.new({ text: "Start Server", action: action(toggleServer) });
  openIntegratedBrowserItem = await MenuItem.new({
    text: "Open Integrated Browser",
    enabled: false,
    action: action(async () => {
      const visible = await invoke<boolean>("frontend_visible");
      if (visible) {
        await invoke("hide_frontend");
      } else {
        await invoke("show_frontend", { port, customUrl: customFrontendUrl });
      }
      await updateFrontendMenuText();
    }),
  });

  openDefaultBrowserItem = await MenuItem.new({
    text: "Open in Default Browser",
    enabled: false,
    action: action(async () => {
      await openUrl(frontendUrl());
    }),
  });

  reloadIntegratedBrowserItem = await MenuItem.new({
    text: "Reload Integrated Browser",
    enabled: false,
    action: action(async () => {
      await invoke("reload_frontend");
      await updateFrontendMenuText();
    }),
  });

  const setFrontendUrlItem = await MenuItem.new({
    text: "Frontend URL…",
    action: action(async () => {
      await invoke("show_frontend_url_settings");
    }),
  });

  frontendItem = await Submenu.new({
    text: "Open Lumiverse",
    items: [openIntegratedBrowserItem, reloadIntegratedBrowserItem, openDefaultBrowserItem, await PredefinedMenuItem.new({ item: "Separator" }), setFrontendUrlItem],
  });

  statsPortItem = await MenuItem.new({ text: "Port: —", enabled: false });
  statsPidItem = await MenuItem.new({ text: "PID: —", enabled: false });
  statsUptimeItem = await MenuItem.new({ text: "Uptime: —", enabled: false });
  statsBranchItem = await MenuItem.new({ text: "Branch: —", enabled: false });
  statsVersionItem = await MenuItem.new({ text: "Version: —", enabled: false });
  const statsSubmenu = await Submenu.new({
    text: "Serving Stats",
    items: [statsPortItem, statsPidItem, statsUptimeItem, statsBranchItem, statsVersionItem],
  });

  checkUpdatesItem = await MenuItem.new({
    text: "Check for Updates",
    action: action(() => checkForUpdates(true)),
  });
  applyUpdateItem = await MenuItem.new({ text: "Apply Update", enabled: false, action: action(applyUpdate) });

  autoStartItem = await CheckMenuItem.new({
    text: "Start Server at Launch",
    checked: settings.autoStartServer,
    action: action(async () => {
      settings.autoStartServer = !settings.autoStartServer;
      await autoStartItem.setChecked(settings.autoStartServer);
      await saveSetting("autoStartServer", settings.autoStartServer);
    }),
  });
  loginItem = await CheckMenuItem.new({
    text: "Launch at Login",
    checked: await autostartEnabled().catch(() => false),
    action: action(async () => {
      if (await autostartEnabled()) {
        await disableAutostart();
        await loginItem.setChecked(false);
      } else {
        await enableAutostart();
        await loginItem.setChecked(true);
      }
    }),
  });

  const setFolderItem = await MenuItem.new({
    text: "Set Lumiverse Folder…",
    action: action(async () => {
      const picked = await invoke<string | null>("pick_folder");
      if (typeof picked !== "string") return;
      if (!(await invoke<boolean>("validate_repo", { path: picked }))) {
        throw new Error("That folder doesn't look like a Lumiverse checkout (scripts/runner.ts not found).");
      }
      if (picked === repoDir) return;

      // A live runner keeps controlling the old checkout — shut it down
      // before switching so every later command targets the new folder.
      const hadRunner = await client.alive();
      const wasRunning = hadRunner && serverState !== "stopped" && serverState !== "crashed";
      if (hadRunner) {
        busyMessage = "Switching folder…";
        await updateMenu();
        await shutdownRunner();
      }

      repoDir = picked;
      await saveSetting("repoDir", picked);
      serverState = "stopped";
      lastStatus = null;
      updateState = { available: false, commitsBehind: 0, latestMessage: "" };
      busyMessage = null;
      await detectExternalServer();
      await updateMenu();
      if (wasRunning) {
        await alert(
          "Lumiverse",
          "The server in the previous folder was stopped. Use Start Server to run the newly selected one.",
        );
      }
    }),
  });

  const quitItem = await MenuItem.new({ text: "Quit Lumiverse", action: action(quit) });
  const separator = () => PredefinedMenuItem.new({ item: "Separator" });

  const menu = await Menu.new({
    items: [
      statusItem,
      await separator(),
      startStopItem,
      frontendItem,
      statsSubmenu,
      await separator(),
      checkUpdatesItem,
      applyUpdateItem,
      await separator(),
      autoStartItem,
      loginItem,
      setFolderItem,
      await separator(),
      quitItem,
    ],
  });

  await TrayIcon.new({
    id: "lumiverse-tray",
    icon: await loadTrayImage(),
    iconAsTemplate: isMac,
    tooltip: "Lumiverse",
    menu,
    showMenuOnLeftClick: true,
  });
}

async function toggleServer(): Promise<void> {
  if (serverState === "running" || serverState === "starting") {
    await stopServer();
  } else {
    await startServer();
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (await client.alive()) {
    await refreshStatus();
  } else {
    await detectExternalServer();
  }
  await updateMenu();
}

async function boot(): Promise<void> {
  settings = await loadSettings();
  customFrontendUrl = settings.customFrontendUrl;

  await listen<{ url: string | null }>("frontend-url-changed", async ({ payload }) => {
    customFrontendUrl = payload.url;
    settings.customFrontendUrl = payload.url;
    await saveSetting("customFrontendUrl", payload.url);
    await updateMenu();
  });

  await client.init();
  client.onState = (state) => {
    serverState = state;
    if (state === "running" && openIntegratedBrowserWhenReady) {
      openIntegratedBrowserWhenReady = false;
      void refreshStatus()
        .then(() => invoke("show_frontend", { port, customUrl: customFrontendUrl }))
        .catch((err) => alert("Lumiverse", err instanceof Error ? err.message : String(err), true));
    } else if (state === "stopped" || state === "crashed") {
      openIntegratedBrowserWhenReady = false;
    }
    if (state === "running" || state === "stopped" || state === "crashed") {
      busyMessage = null;
    }
    void refreshStatus().then(updateMenu);
  };
  client.onProgress = (_operation, progressText) => {
    busyMessage = progressText;
    void updateMenu();
  };
  client.onExit = () => {
    serverState = "stopped";
    lastStatus = null;
    busyMessage = null;
    void updateMenu();
  };

  // Stored choice first; otherwise discover the checkout this build
  // lives inside (dev builds run from <repo>/desktop/src-tauri/target).
  // Nothing is baked in at build time — installed copies with no stored
  // setting start unconfigured and ask for an explicit selection.
  const candidateRepo = settings.repoDir ?? (await invoke<string | null>("discover_repo"));
  repoDir =
    candidateRepo && (await invoke<boolean>("validate_repo", { path: candidateRepo }))
      ? candidateRepo
      : null;
  bunPath = settings.bunPath ?? (await invoke<string | null>("resolve_bun"));

  await buildTray();
  await updateMenu();

  if (!repoDir && !customFrontendUrl) {
    await alert(
      "Lumiverse",
      "No Lumiverse folder is configured yet. Choose your Lumiverse checkout via “Set Lumiverse Folder…” in the tray menu.",
    );
  }

  if (settings.autoStartServer && repoDir && bunPath) {
    action(startServer)();
  } else {
    void detectExternalServer().then(updateMenu);
  }

  setInterval(() => void tick(), POLL_INTERVAL_MS);
}

void boot();
