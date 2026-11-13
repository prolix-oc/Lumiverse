/**
 * Lumiverse Desktop — experimental Tauri-powered integrated browser and tray.
 *
 * Owns a headless Lumiverse runner (scripts/runner.ts --headless), presents
 * Lumiverse in its native WebView, and keeps server controls available from
 * the tray: status, start/stop, serving stats, updates, and launch options.
 */

import { invoke } from "@tauri-apps/api/core";
import { LocalServerClient, resolveLocalServerSource } from "./local-server";
import { changeNetworkAccess, type BundledNetworkAccess } from "./network-access";
import { Image } from "@tauri-apps/api/image";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
import {
  type DesktopShellState,
  type FullStatus,
  type ServerState,
  type UpdateState,
} from "./runner-client";
import { loadSettings, saveSetting, type TraySettings } from "./settings";
import { restoreDesktopCaptureConnection, type DesktopCaptureStatus } from "./desktop-capture";
import { createDiscordPresenceRefreshQueue } from "./discord-presence";
import { restoreDesktopSession, type DesktopUpdateResume } from "./update-resume";
import { installDesktopRelease, type DesktopUpdateChannel, type DesktopUpdateInfo, type DesktopReleaseUpdate } from "./desktop-updates";
import { type InstanceConnection, type InstanceConnectionChange, LOCAL_INSTANCE_CONNECTION } from "./instance-connection";
import {
  pendingRemoteSnapshot,
  type RemoteInstanceSnapshot,
} from "./remote-instance";
import trayMacIcon from "./assets/tray-mac.png";
import trayWinIcon from "./assets/tray-win.png";

const POLL_INTERVAL_MS = 15_000;
// A cold Tauri build compiles the entire native dependency tree. This only
// bounds the tray's wait; keep it above the runner's two-hour build deadline
// so the request client can never become the earlier cutoff.
const DESKTOP_REBUILD_TIMEOUT_MS = 2 * 60 * 60_000 + 5 * 60_000;
const isMac = navigator.userAgent.includes("Mac");
const isWindows = navigator.userAgent.includes("Windows");
const isLinux = navigator.userAgent.includes("Linux");
let remoteAuthorizationId: string | null = null;
let remoteAuthorizationLastId: string | null = null;
let remoteAuthorizationLastOrigin: string | null = null;
let remoteAuthorizationTask: Promise<void> | null = null;

/**
 * Alerts and pickers go through Rust commands so they never parent to —
 * and thereby reveal — the hidden host window.
 */
function alert(title: string, text: string, error = false): Promise<void> {
  return invoke("alert", { title, message: text, error });
}

// ─── App state ──────────────────────────────────────────────────────────────

const client = new LocalServerClient();
let bundledServerAvailable = false;
let connectionChange = Promise.resolve();
let desktopProfile: { isolated: boolean; name: string | null } = { isolated: false, name: null };
let settings: TraySettings;
let repoDir: string | null = null;
let bunPath: string | null = null;
let serverState: ServerState = "stopped";
let externalRunning = false;
let busyMessage: string | null = null;
let port = 7860;
let lastStatus: FullStatus | null = null;
let updateState: UpdateState = { available: false, commitsBehind: 0, latestMessage: "" };
let desktopUpdateInfo: DesktopUpdateInfo;
let desktopUpdateChannel: DesktopUpdateChannel = "stable";
let desktopReleaseUpdate: DesktopReleaseUpdate | null = null;
let checkingDesktopUpdate = false;
let installingDesktopUpdate = false;
// The tray is a compiled binary the git update flow cannot replace, so a pull
// carrying desktop changes leaves this process running superseded code.
let desktopShellStale = false;
let desktopShellNoticeShown = false;
let instanceConnection: InstanceConnection = LOCAL_INSTANCE_CONNECTION;
let remoteSnapshot: RemoteInstanceSnapshot | null = null;
let openIntegratedBrowserWhenReady = false;
let bundledNetworkAccess: BundledNetworkAccess | null = null;
let changingNetworkAccess = false;
let networkAccessRequest = 0;

// ─── Discord Rich Presence ──────────────────────────────────────────────────
// The tray fetches the active-chat snapshot on chat switches and polls the
// instance's desktop API as a fallback. It relays each snapshot to the Rust
// worker, which owns the Discord IPC connection. When
// the Discord toggle is switched on without a usable desktop session, the
// standard remote-instance OAuth sign-in runs once against the current
// origin (local instances included) — always as a direct consequence of the
// user's click, never from a background poll.

interface DiscordPresenceSnapshot {
  chatId: string | null;
  characterName: string | null;
  messageCount: number | null;
  totalTokens: number | null;
  model: string | null;
  characterCount?: number | null;
}

type DiscordPresenceFetch =
  | { state: "active"; snapshot: DiscordPresenceSnapshot }
  | { state: "inactive" }
  | { state: "disconnected" }
  | { state: "reauth_required"; error: string | null }
  | { state: "unreachable"; error: string | null };

let discordPresenceEverActive = false;
let discordPresenceIssueAlerted = false;

function isRemoteMode(): boolean {
  return instanceConnection.mode === "remote";
}

function usesBundledServer(): boolean { return client.source === "bundled"; }

function remoteFrontendUrl(): string | null {
  return instanceConnection.mode === "remote" ? instanceConnection.origin : null;
}

// ─── Menu items (created once, text/enabled updated in place) ───────────────

let statusItem: MenuItem;
let startStopItem: MenuItem;
let frontendItem: Submenu;
let statsPortItem: MenuItem;
let statsPidItem: MenuItem;
let statsUptimeItem: MenuItem;
let statsBranchItem: MenuItem;
let statsVersionItem: MenuItem;
let remoteAccessItem: CheckMenuItem;
let checkUpdatesItem: MenuItem;
let applyUpdateItem: MenuItem;
let rebuildDesktopItem: MenuItem;
let openDataFolderItem: MenuItem;
let desktopUpdatesItem: Submenu;
let desktopCheckItem: MenuItem;
let desktopInstallItem: MenuItem;
let stableUpdatesItem: CheckMenuItem;
let nightlyUpdatesItem: CheckMenuItem;
let autoStartItem: CheckMenuItem;
let discordRpcItem: CheckMenuItem;
let systemAudioItem: CheckMenuItem;
let trayIcon: TrayIcon;
let loginItem: CheckMenuItem;
let openIntegratedBrowserItem: MenuItem;
let openDefaultBrowserItem: MenuItem;
let reloadIntegratedBrowserItem: MenuItem;
let remoteAuthItem: MenuItem;
let remoteDisconnectItem: MenuItem;
let desktopCaptureItem: CheckMenuItem;
let desktopCaptureRetryAt = 0;
let desktopCaptureRestoring = false;
let desktopCaptureSwitching = 0;
let desktopCaptureEnabling = false;
let desktopCaptureRevision = 0;
let floatingWidgetsItem: Submenu;

interface DesktopWidgetCatalogEntry {
  id: string;
  extensionId: string;
  index: number;
  title: string;
  width: number;
  height: number;
}

interface DesktopWidgetPopoutState {
  id: string;
  poppedOut: boolean;
}

let desktopWidgetCatalog: DesktopWidgetCatalogEntry[] = [];
const poppedOutWidgetIds = new Set<string>();

function statusText(): string {
  if (isRemoteMode()) {
    const name = remoteSnapshot?.instance?.name ?? (
      instanceConnection.mode === "remote"
        ? instanceConnection.displayName ?? new URL(instanceConnection.origin).hostname
        : "Remote instance"
    );
    switch (remoteSnapshot?.state) {
      case "authorizing":
        return `Authorizing Desktop for ${name}…`;
      case "connected":
        return `${name} · connected`;
      case "restricted":
        return `${name} · status restricted`;
      case "unreachable":
        return `${name} · unreachable`;
      case "reauth_required":
        return `${name} · sign-in required`;
      default:
        return `${name} · sign-in required`;
    }
  }
  if (busyMessage) return busyMessage;
  // A dismissed dialog is easy to forget, and the symptom of a stale shell is
  // simply that the old behaviour persists. Keep the state visible in the
  // headline for as long as it is true.
  const suffix = desktopShellStale ? " · desktop rebuild required" : "";
  if (externalRunning) return `Lumiverse running (external)${suffix}`;
  if (suffix) {
    switch (serverState) {
      case "running":
        return `Lumiverse running${suffix}`;
      case "stopped":
        return `Lumiverse stopped${suffix}`;
    }
  }
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

function formatElapsed(elapsedMs: number | null | undefined): string {
  if (elapsedMs == null || elapsedMs < 0) return "—";
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function updateFrontendMenuText(): Promise<void> {
  const running = serverState === "running" || externalRunning;
  const frontendAvailable = running || isRemoteMode();
  const visible = await invoke<boolean>("frontend_visible").catch(() => false);
  const exists = await invoke<boolean>("frontend_exists").catch(() => false);

  await openIntegratedBrowserItem.setText(visible ? "Close Integrated Browser" : "Open Integrated Browser");
  await openIntegratedBrowserItem.setEnabled(frontendAvailable);
  await openDefaultBrowserItem.setEnabled(frontendAvailable);
  await reloadIntegratedBrowserItem.setEnabled(frontendAvailable && exists);
}

function frontendUrl(): string {
  // Keep the local browser and local auth callback on one host. Cookies are host
  // scoped, so mixing 127.0.0.1 here with a localhost callback loses the
  // newly-created SSO session when the provider returns.
  return remoteFrontendUrl() ?? `http://localhost:${port}`;
}

async function updateMenu(): Promise<void> {
  const running = serverState === "running";
  const transitioning = serverState === "starting" || serverState === "stopping" || busyMessage !== null || installingDesktopUpdate || changingNetworkAccess;
  const remote = isRemoteMode();

  await statusItem.setText(statusText());

  if (remote) {
    await startStopItem.setText("Remote Instance");
    await startStopItem.setEnabled(false);
  } else if (externalRunning) {
    await startStopItem.setText("Stop Server");
    await startStopItem.setEnabled(false);
  } else {
    await startStopItem.setText(running || serverState === "starting" ? "Stop Server" : "Start Server");
    await startStopItem.setEnabled(!installingDesktopUpdate && (!transitioning || serverState === "starting"));
  }

  await updateFrontendMenuText();

  await remoteAuthItem.setText(
    remoteSnapshot?.state === "connected" || remoteSnapshot?.state === "restricted"
      ? "Reconnect Desktop Authorization…"
      : "Authorize Desktop…",
  );
  await remoteAuthItem.setEnabled(remote && remoteSnapshot?.state !== "authorizing");
  await remoteDisconnectItem.setEnabled(
    remote && remoteSnapshot !== null && remoteSnapshot.state !== "disconnected" && remoteSnapshot.state !== "authorizing",
  );

  await restoreDesktopCapture();
  const capture = await invoke<DesktopCaptureStatus>("desktop_capture_status");
  if (capture.disabledByUser && settings.desktopCaptureOrigin) {
    settings.desktopCaptureOrigin = null;
    await saveSetting("desktopCaptureOrigin", null);
  }
  await desktopCaptureItem.setChecked(settings.desktopCaptureOrigin === new URL(frontendUrl()).origin);
  await desktopCaptureItem.setText(capture.capabilities.image
    ? "Let Extensions Capture the Screen"
    : "Extension Screen Capture (not on this OS yet)");
  await desktopCaptureItem.setEnabled(capture.capabilities.image && !transitioning && !desktopCaptureEnabling);

  await statsPortItem.setText(`Port: ${remote ? (remoteSnapshot?.status?.port ?? "—") : port}`);
  await statsPidItem.setText(`PID: ${remote ? (remoteSnapshot?.status?.pid ?? "—") : (lastStatus?.pid ?? "—")}`);
  await statsUptimeItem.setText(`Uptime: ${remote
    ? formatElapsed(remoteSnapshot?.status?.uptime)
    : (running ? formatUptime(lastStatus?.startedAt ?? null) : "—")}`);
  await statsBranchItem.setText(`Branch: ${remote ? (remoteSnapshot?.status?.branch ?? "—") : (lastStatus?.branch ?? "—")}`);
  await statsVersionItem.setText(`Version: ${remote ? (remoteSnapshot?.status?.version ?? "—") : (lastStatus?.version ?? "—")}`);
  const access = !remote && usesBundledServer() ? bundledNetworkAccess : null;
  await remoteAccessItem.setChecked(access?.enabled ?? false);
  await remoteAccessItem.setText(access?.overridden ? "Allow Remote Access (set by launch override)" : "Allow Remote Access");
  await remoteAccessItem.setEnabled(Boolean(access?.configured && !access.overridden && !transitioning && !externalRunning));

  await checkUpdatesItem.setEnabled(!usesBundledServer() && !remote && !busyMessage && !externalRunning);
  // The rebuild compiles from the configured checkout, so it needs one — but
  // unlike the update items it stays available when a server is running
  // externally, since it neither stops nor talks to that server.
  await rebuildDesktopItem.setEnabled(!usesBundledServer() && !busyMessage && repoDir !== null);
  await openDataFolderItem.setEnabled(!remote && !busyMessage && (usesBundledServer() || (!!repoDir && !!bunPath)));
  const canUpdateDesktop = desktopUpdateInfo.enabled && !checkingDesktopUpdate && !installingDesktopUpdate && !busyMessage;
  await desktopCheckItem.setEnabled(canUpdateDesktop);
  await desktopCheckItem.setText(checkingDesktopUpdate ? "Checking for Desktop Updates…" : "Check for Desktop Updates");
  await desktopInstallItem.setText(desktopReleaseUpdate ? `Update to ${desktopReleaseUpdate.version}…` : "Install Desktop Update…");
  await desktopInstallItem.setEnabled(canUpdateDesktop && desktopReleaseUpdate !== null);
  await stableUpdatesItem.setChecked(desktopUpdateChannel === "stable");
  await nightlyUpdatesItem.setChecked(desktopUpdateChannel === "nightly");
  await stableUpdatesItem.setEnabled(canUpdateDesktop);
  await nightlyUpdatesItem.setEnabled(canUpdateDesktop);
  if (updateState.available) {
    await applyUpdateItem.setText(`Apply Update (${updateState.commitsBehind} behind)`);
    await applyUpdateItem.setEnabled(!usesBundledServer() && !remote && !busyMessage && !externalRunning);
  } else {
    await applyUpdateItem.setText("Apply Update");
    await applyUpdateItem.setEnabled(false);
  }
}

async function updateFloatingWidgetMenu(): Promise<void> {
  if (!floatingWidgetsItem) return;

  const existingItems = await floatingWidgetsItem.items();
  for (const item of existingItems) {
    await floatingWidgetsItem.remove(item);
  }

  if (desktopWidgetCatalog.length === 0) {
    await floatingWidgetsItem.append(await MenuItem.new({
      text: "No registered extension widgets",
      enabled: false,
    }));
  } else {
    for (const widget of desktopWidgetCatalog) {
      const poppedOut = poppedOutWidgetIds.has(widget.id);
      await floatingWidgetsItem.append(await MenuItem.new({
        text: poppedOut ? `Return ${widget.title} to Page` : `Pop Out ${widget.title}`,
        action: action(async () => {
          if (poppedOut) {
            // This command is invoked by the trusted tray rather than a remote
            // frontend, so it does not need a child-window ownership check.
            await invoke("return_extension_widget_from_tray", { widgetId: widget.id });
          } else {
            await invoke("show_extension_widget", { widgetId: widget.id });
          }
        }),
      }));
    }
  }
}

// ─── Runner orchestration ───────────────────────────────────────────────────

async function ensureRunner(): Promise<void> {
  if (await client.alive()) return;
  if (usesBundledServer()) { await client.spawn("", ""); return; }
  if (!repoDir) {
    throw new Error("No Lumiverse checkout configured. Choose one under Browser → Instance Connection… first.");
  }
  if (!bunPath) {
    throw new Error("Bun was not found. Install it from https://bun.sh and relaunch.");
  }
  await client.spawn(repoDir, bunPath);
}

async function refreshStatus(): Promise<void> {
  if (!changingNetworkAccess) await refreshNetworkAccess();
  if (!(await client.alive())) return;
  try {
    const source = client.source;
    const checkout = repoDir;
    const status = await client.fullStatus();
    if (source !== client.source || (source === "checkout" && checkout !== repoDir)) return;
    lastStatus = status;
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

async function refreshNetworkAccess(): Promise<void> {
  const request = ++networkAccessRequest;
  if (isRemoteMode() || !usesBundledServer()) { bundledNetworkAccess = null; return; }
  try {
    const access = await invoke<BundledNetworkAccess>("bundled_server_network_access");
    if (request === networkAccessRequest && !isRemoteMode() && usesBundledServer()) bundledNetworkAccess = access;
  } catch {
    // An unavailable or invalid configuration cannot be represented by a toggle.
    if (request === networkAccessRequest) bundledNetworkAccess = null;
  }
}

function toggleRemoteAccess(): Promise<void> {
  // Use the same queue as instance selection so a late restart cannot start a
  // local server after the owner has switched to a remote instance or checkout.
  const task = connectionChange.then(async () => {
    if (isRemoteMode() || !usesBundledServer() || busyMessage || installingDesktopUpdate || externalRunning
      || serverState === "starting" || serverState === "stopping"
      || !bundledNetworkAccess?.configured || bundledNetworkAccess.overridden) {
      await updateMenu();
      return;
    }
    const enabled = !bundledNetworkAccess.enabled;
    const running = serverState === "running";
    changingNetworkAccess = true;
    networkAccessRequest++;
    busyMessage = "Saving remote access…";
    try {
      await updateMenu();
      bundledNetworkAccess = await changeNetworkAccess({
        enabled, running,
        save: (enabled) => invoke<BundledNetworkAccess>("bundled_server_set_network_access", { enabled }),
        stop: stopServer,
        start: () => startServer(false),
      });
    } finally {
      changingNetworkAccess = false;
      busyMessage = null;
      await refreshStatus();
      await updateMenu();
    }
  });
  connectionChange = task.catch(() => {});
  return task;
}

async function startServer(reopenFrontend = true): Promise<void> {
  if (isRemoteMode()) throw new Error("Switch to the local instance before starting its server.");
  if (!settings.instanceConnectionConfigured) {
    settings.instanceConnectionConfigured = true;
    await saveSetting("instanceConnection", LOCAL_INSTANCE_CONNECTION);
  }
  await ensureRunner();
  if (!usesBundledServer()) {
    // Read the checkout's configured port before looking for a server started elsewhere.
    await refreshStatus();
    await detectExternalServer();
    if (externalRunning) {
      if (reopenFrontend) await invoke("show_frontend", { port, customUrl: null });
      await updateMenu();
      return;
    }
  }
  // The runner acknowledges this request while the server is still starting.
  // Defer opening the native WebView until its `running` state notification.
  openIntegratedBrowserWhenReady = reopenFrontend;
  serverState = "starting";
  await updateMenu();
  await client.request("start-server");
  await refreshStatus();
  if (openIntegratedBrowserWhenReady && lastStatus?.state === "running") {
    openIntegratedBrowserWhenReady = false;
    await invoke("show_frontend", { port, customUrl: remoteFrontendUrl() });
  }
  await updateMenu();
}

async function stopServer(): Promise<void> {
  if (isRemoteMode()) throw new Error("Switch to the local instance before stopping its server.");
  openIntegratedBrowserWhenReady = false;
  serverState = "stopping";
  updateMenuInBackground();
  try {
    await client.request("stop-server", undefined, 30_000);
  } finally {
    // Restore the actual state if the runner rejects the request (for example
    // while an update is in progress), instead of leaving Stop disabled.
    await refreshStatus();
    updateMenuInBackground();
  }
}

async function checkForUpdates(interactive: boolean): Promise<void> {
  if (isRemoteMode()) throw new Error("Switch to the local instance before checking its checkout for updates.");
  await ensureRunner();
  const result = await client.request<UpdateState>("check-updates", undefined, 90_000);
  updateState = result;
  await updateMenu();
  await refreshDesktopShellState();
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

async function checkDesktopUpdates(interactive = false): Promise<void> {
  if (!desktopUpdateInfo.enabled || checkingDesktopUpdate || installingDesktopUpdate || busyMessage) return;
  checkingDesktopUpdate = true;
  await updateMenu();
  try {
    desktopReleaseUpdate = await invoke<DesktopReleaseUpdate | null>("desktop_update_check", { channel: desktopUpdateChannel });
    if (interactive) {
      await alert("Lumiverse Desktop", desktopReleaseUpdate
        ? `Version ${desktopReleaseUpdate.version} is available on ${desktopUpdateChannel}.\n\n${desktopReleaseUpdate.notes || ""}\nUse Desktop Updates → Update to ${desktopReleaseUpdate.version}… to install.`
        : `No newer ${desktopUpdateChannel} desktop release is available. Installed: ${desktopUpdateInfo.version}.`);
    }
  } catch (error) {
    desktopReleaseUpdate = null;
    if (interactive) throw error;
    console.warn("Unable to check desktop updates", error);
  } finally {
    checkingDesktopUpdate = false;
    await updateMenu();
  }
}

async function selectDesktopUpdateChannel(channel: DesktopUpdateChannel): Promise<void> {
  if (installingDesktopUpdate || checkingDesktopUpdate || busyMessage) { await updateMenu(); return; }
  await saveSetting("desktopUpdateChannel", channel);
  desktopUpdateChannel = channel;
  desktopReleaseUpdate = null;
  await updateMenu();
  await checkDesktopUpdates();
}

async function applyDesktopUpdate(): Promise<void> {
  const update = desktopReleaseUpdate;
  if (!update || installingDesktopUpdate || checkingDesktopUpdate || busyMessage) return;
  installingDesktopUpdate = true;
  busyMessage = "Preparing desktop update…";
  let downloaded = false;
  await updateMenu();
  try {
    const confirmed = await invoke<boolean>("confirm", {
      title: "Update Lumiverse Desktop",
      message: `Download and install ${update.version} from ${update.channel}?\n\nLumiverse Desktop will restart after the download is verified. Your managed local server will stop for installation and resume if it was running.`,
      okLabel: "Update and restart", cancelLabel: "Later",
    });
    if (!confirmed) return;
    busyMessage = "Downloading desktop update…";
    await updateMenu();
    await installDesktopRelease({
      download: async () => { await invoke("desktop_update_download", { version: update.version, channel: update.channel }); downloaded = true; },
      captureResume: async () => {
        await refreshStatus();
        return {
          resumeServer: !isRemoteMode() && !externalRunning && await client.alive() && (serverState === "running" || serverState === "starting"),
          reopenFrontend: await invoke<boolean>("frontend_visible"),
          localPort: isRemoteMode() ? undefined : port,
        };
      },
      stop: async () => { busyMessage = "Installing desktop update…"; await updateMenu(); await shutdownRunner(); },
      install: async (resume) => { await invoke("desktop_update_install", { version: update.version, channel: update.channel, ...resume }); },
      restore: async (resume) => { await startServer(resume.reopenFrontend); },
    });
  } finally {
    if (downloaded) desktopReleaseUpdate = null;
    installingDesktopUpdate = false;
    busyMessage = null;
    await updateMenu();
  }
}

/**
 * Ask the checkout whether it has moved past the desktop sources this binary
 * was compiled from. Only the checkout can answer — the shell knows just the
 * revision stamped into it at build time.
 */
async function refreshDesktopShellState(): Promise<void> {
  if (usesBundledServer() || !repoDir || !(await client.alive())) return;
  const checkout = repoDir;

  // Separate the two failure modes. A runner that predates this message is
  // expected and transient — stay quiet and keep any verdict we already hold.
  // The command failing is not: it means the shell is misconfigured, and
  // swallowing that is what let this check silently never run at all.
  let builtSha: string | null;
  try {
    builtSha = await invoke<string | null>("desktop_shell_sha");
  } catch (error) {
    console.error(
      "[desktop-shell] Could not read this build's revision, so the " +
        "rebuild check cannot run. Is desktop_shell_sha missing from the " +
        "tray-commands permission?",
      error,
    );
    return;
  }

  let state: DesktopShellState;
  try {
    state = await client.request<DesktopShellState>("desktop-shell-status", { builtSha }, 15_000);
  } catch {
    // An older runner does not know this message. Leave the previous verdict
    // alone rather than clearing a warning we still believe.
    return;
  }
  if (usesBundledServer() || repoDir !== checkout) return;

  const becameStale = state.stale && !desktopShellStale;
  desktopShellStale = state.stale;
  // A rebuild clears the condition; let the notice fire again if it recurs.
  if (!state.stale) desktopShellNoticeShown = false;
  await updateMenu();

  if (becameStale && !desktopShellNoticeShown) {
    desktopShellNoticeShown = true;
    const rebuildNow = await invoke<boolean>("confirm", {
      title: "Lumiverse Desktop rebuild required",
      message:
        "This update changed Lumiverse Desktop itself. The app you are running " +
        "was built before those changes and keeps its previous behaviour " +
        "until it is rebuilt.\n\n" +
        "Rebuild it now? You can keep using Lumiverse while it compiles. " +
        "Or later, from the tray menu: Rebuild Desktop App…\n\n" +
        `Manual equivalent: cd ${repoDir}/desktop && bun run tauri:finalized build`,
      okLabel: "Rebuild now",
      cancelLabel: "Later",
    });
    if (rebuildNow) action(rebuildDesktop)();
  }
}

async function applyUpdate(): Promise<void> {
  if (isRemoteMode()) throw new Error("Switch to the local instance before updating its checkout.");
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
 * Compile the desktop shell from the configured checkout.
 *
 * Windows can hand the fresh NSIS bundle to a detached native helper, then
 * gracefully exit so that helper can install it and relaunch the application.
 * Other platforms retain the existing manual bundle handoff for now.
 */
async function rebuildDesktop(): Promise<void> {
  await ensureRunner();
  busyMessage = "Preparing desktop rebuild…";
  await updateMenu();
  try {
    // The runner answers when the compile finishes rather than acking early,
    // so this waits out the whole build. Progress arrives via onProgress.
    const result = await client.request<{ bundlePath: string | null }>(
      "rebuild-desktop",
      undefined,
      DESKTOP_REBUILD_TIMEOUT_MS,
    );
    busyMessage = null;
    await updateMenu();

    if (!result?.bundlePath) {
      await alert("Lumiverse", "The desktop app was rebuilt.");
      return;
    }

    if (!isWindows) {
      await alert(
        "Desktop app rebuilt",
        "The new build is ready. Quit Lumiverse Desktop and replace the " +
          "installed app with it to finish updating.\n\n" +
          result.bundlePath,
      );
      await invoke("reveal_desktop_artifact", { path: result.bundlePath }).catch(() => {});
      return;
    }

    if (!repoDir) {
      throw new Error("No Lumiverse checkout is configured for the desktop update.");
    }

    const restartNow = await invoke<boolean>("confirm", {
      title: "Desktop app rebuilt",
      message:
        "The new desktop build is ready. Restart Lumiverse Desktop now to install it?\n\n" +
        "The app will close, the NSIS installer will run silently, and Lumiverse Desktop " +
        "will reopen automatically. Your checkout is not modified by this step.",
      okLabel: "Install and restart",
      cancelLabel: "Later",
    });

    if (!restartNow) {
      // Keep the old escape hatch: the bundle remains usable for a manual
      // install, and revealing it makes choosing Later non-destructive.
      await invoke("reveal_desktop_artifact", { path: result.bundlePath }).catch(() => {});
      return;
    }

    try {
      // Capture at handoff time, since the user can start/stop the server or
      // hide the browser during a long build. Do not restart external servers.
      const status = await client.fullStatus();
      const reopenFrontend = await invoke<boolean>("frontend_visible");
      await invoke("stage_desktop_update", {
        artifactPath: result.bundlePath,
        repoDir,
        resumeServer: !isRemoteMode() && (status.state === "running" || status.state === "starting"),
        reopenFrontend,
      });
    } catch (error) {
      await invoke("reveal_desktop_artifact", { path: result.bundlePath }).catch(() => {});
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The desktop build succeeded, but the automatic installer handoff failed: ${reason}\n\n` +
          `The bundle is still available at:\n${result.bundlePath}`,
      );
    }

    // The native helper is now independent of this process and waits for our
    // PID to disappear before running NSIS. Use the normal graceful shutdown
    // so the runner/server are not abandoned during the handoff.
    await quit();
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
  openIntegratedBrowserWhenReady = false;
  await client.shutdown();
}

async function quit(): Promise<void> {
  busyMessage = "Shutting down…";
  updateMenuInBackground();
  try {
    await shutdownRunner();
  } finally {
    // The native command performs a final process cleanup even if the JS
    // handshake or its force-kill invoke failed.
    await invoke("quit_app");
  }
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

async function persistRemoteIdentity(snapshot: RemoteInstanceSnapshot): Promise<void> {
  if (instanceConnection.mode !== "remote" || !snapshot.instance) return;
  if (
    instanceConnection.instanceId === snapshot.instance.id
    && instanceConnection.displayName === snapshot.instance.name
  ) return;
  instanceConnection = {
    ...instanceConnection,
    instanceId: snapshot.instance.id,
    displayName: snapshot.instance.name,
  };
  settings.instanceConnection = instanceConnection;
  const remote = instanceConnection;
  await saveSetting("instanceConnection", remote);
  settings.savedRemoteConnection = remote;
  await saveSetting("savedRemoteConnection", remote);
}

async function pollRemoteInstance(): Promise<void> {
  if (instanceConnection.mode !== "remote" || remoteSnapshot?.state === "authorizing") return;
  const origin = instanceConnection.origin;
  const before = remoteSnapshot;
  const snapshot = await invoke<RemoteInstanceSnapshot>("remote_instance_poll", {
    origin,
  });
  if (instanceConnection.mode !== "remote" || instanceConnection.origin !== origin || remoteSnapshot !== before) return;
  remoteSnapshot = snapshot;
  await persistRemoteIdentity(snapshot);
}

function connectRemoteInstance(): Promise<void> {
  if (instanceConnection.mode !== "remote") return Promise.resolve();
  return connectDesktopAuthorization(instanceConnection.origin);
}

function connectDesktopAuthorization(origin: string): Promise<void> {
  if (remoteAuthorizationTask) return remoteAuthorizationTask;
  const task = authorizeRemoteInstance(origin);
  remoteAuthorizationTask = task;
  void task.finally(() => { if (remoteAuthorizationTask === task) remoteAuthorizationTask = null; }).catch(() => {});
  return task;
}

async function cancelRemoteAuthorization(): Promise<void> {
  const id = remoteAuthorizationId;
  remoteAuthorizationId = null;
  if (id) {
    await invoke("remote_authorization_cancel", { attemptId: id });
    if (remoteSnapshot?.state === "authorizing") remoteSnapshot = { ...remoteSnapshot, state: "reauth_required" };
  }
  // Let the native future close its listener before a retry starts.
  if (remoteAuthorizationTask) await remoteAuthorizationTask.catch(() => {});
}

async function authorizeRemoteInstance(origin: string): Promise<void> {
  const id = crypto.randomUUID();
  remoteAuthorizationId = id;
  remoteAuthorizationLastId = id;
  remoteAuthorizationLastOrigin = origin;
  const current = () => remoteAuthorizationId === id && new URL(frontendUrl()).origin === origin;
  const selectedRemote = () => instanceConnection.mode === "remote" && instanceConnection.origin === origin;
  try {
    if (selectedRemote()) remoteSnapshot = pendingRemoteSnapshot(origin);
    await updateMenu();
    if (!current()) return;
    const snapshot = await invoke<RemoteInstanceSnapshot>("remote_instance_connect", { origin, attemptId: id });
    if (!current()) return;
    if (selectedRemote()) {
      remoteSnapshot = snapshot;
      await persistRemoteIdentity(snapshot);
    }
    if (!snapshot.credentialPersisted) {
      await alert("Lumiverse Desktop", "Desktop is connected for this session, but its refresh credential could not be saved in the operating system credential store. Sign in again after restarting Desktop.");
    }
  } catch (error) {
    if (!current()) return;
    if (selectedRemote()) remoteSnapshot = { ...pendingRemoteSnapshot(origin), state: "reauth_required", error: error instanceof Error ? error.message : String(error) };
    // The local sign-in window supplies Retry, Cancel, and the manual link.
    // Menu errors still reach the normal tray error handler.
    if (!String(error).includes("cancelled")) throw error;
  } finally {
    if (current()) {
      remoteAuthorizationId = null;
      if (remoteSnapshot?.state === "authorizing") remoteSnapshot = { ...pendingRemoteSnapshot(origin), state: "reauth_required" };
    }
    await updateMenu();
  }
}

async function disconnectRemoteInstance(): Promise<void> {
  if (instanceConnection.mode !== "remote") return;
  await cancelRemoteAuthorization();
  await invoke("remote_instance_disconnect", { origin: instanceConnection.origin });
  remoteSnapshot = {
    ...pendingRemoteSnapshot(instanceConnection.origin),
    state: "disconnected",
  };
  await updateMenu();
}

async function enableDesktopCapture(): Promise<void> {
  const origin = new URL(frontendUrl()).origin;
  if (desktopCaptureSwitching || desktopCaptureEnabling || settings.desktopCaptureOrigin === origin) return;
  const revision = ++desktopCaptureRevision;
  const current = () => revision === desktopCaptureRevision && !desktopCaptureSwitching && origin === new URL(frontendUrl()).origin;
  desktopCaptureEnabling = true;
  try {
    const allowed = await invoke<boolean>("confirm", {
      title: "Let extensions capture the screen?",
      message: "Screen capture stays enabled for this Lumiverse instance until you turn it off. Each permitted extension asks you to choose a source the first time it uses a destination. That source is remembered for later requests. Turning this off stops capture and forgets saved approvals. Canceling a capture keeps your saved permissions. Screen capture never records audio.",
      okLabel: "Enable Screen Capture", cancelLabel: "Cancel",
    });
    if (!allowed || !current()) return;
    const authorization = await invoke<RemoteInstanceSnapshot>("remote_instance_poll", { origin });
    if (!current()) return;
    if (authorization.state !== "connected" && authorization.state !== "restricted") {
      await connectDesktopAuthorization(origin);
    }
    if (!current()) return;
    await invoke("desktop_capture_reset_approvals", { forget: true });
    if (!current()) return;
    await invoke("desktop_capture_connect", { origin });
    if (!current()) {
      await invoke("desktop_capture_disconnect", { origin });
      return;
    }
    settings.desktopCaptureOrigin = origin;
    await saveSetting("desktopCaptureOrigin", origin);
  } finally {
    desktopCaptureEnabling = false;
  }
}

async function disableDesktopCapture(): Promise<void> {
  desktopCaptureRevision++;
  settings.desktopCaptureOrigin = null;
  // Native disable takes effect even if saving the WebView preference fails.
  try {
    await invoke("desktop_capture_reset_approvals", { forget: true, disabled: true });
  } finally {
    await saveSetting("desktopCaptureOrigin", null);
  }
}

async function restoreDesktopCapture(): Promise<void> {
  const origin = settings.desktopCaptureOrigin;
  const wanted = () => !desktopCaptureSwitching && settings.desktopCaptureOrigin === origin && origin === new URL(frontendUrl()).origin;
  if (!origin || !wanted() || serverState === "starting" || serverState === "stopping" || busyMessage !== null || installingDesktopUpdate || desktopCaptureRestoring || Date.now() < desktopCaptureRetryAt) return;
  desktopCaptureRestoring = true;
  desktopCaptureRetryAt = Date.now() + 15_000;
  try {
    await restoreDesktopCaptureConnection(origin, wanted, {
      status: () => invoke<DesktopCaptureStatus>("desktop_capture_status"),
      connect: origin => invoke("desktop_capture_connect", { origin }),
      disconnect: origin => invoke("desktop_capture_disconnect", { origin }),
    });
  } catch { /* Reconnect only with existing native credentials; setup owns interactive authorization. */ }
  finally { desktopCaptureRestoring = false; }
}

async function toggleDesktopCapture(): Promise<void> {
  const capture = await invoke<DesktopCaptureStatus>("desktop_capture_status");
  if (capture.enabled || settings.desktopCaptureOrigin === new URL(frontendUrl()).origin) {
    await disableDesktopCapture();
  } else {
    await enableDesktopCapture();
  }
  await updateMenu();
}

// ─── Discord Rich Presence plumbing ─────────────────────────────────────────

/** The instance origin the presence snapshot should be read from, if any. */
function presenceOrigin(): string | null {
  // Inline the mode check so TypeScript narrows `instanceConnection`.
  if (instanceConnection.mode === "remote") return instanceConnection.origin;
  if (serverState === "running" || externalRunning) return `http://localhost:${port}`;
  return null;
}

/**
 * Poll the active-chat snapshot once and relay it to the Discord worker.
 * Never throws — a failed poll keeps the last known presence until the next
 * tick. Returns "needs-auth" when the instance requires a desktop sign-in.
 */
async function pollDiscordPresence(): Promise<"ok" | "needs-auth"> {
  if (!settings.discordRpcEnabled) return "ok";
  try {
    const origin = presenceOrigin();
    if (!origin) {
      await invoke("discord_rpc_update", { payload: null });
      return "ok";
    }
    const result = await invoke<DiscordPresenceFetch>("discord_presence_fetch", { origin });
    // A fetch for the old instance must not overwrite the new selection or
    // restore activity after the user disables presence.
    if (!settings.discordRpcEnabled || presenceOrigin() !== origin) return "ok";
    switch (result.state) {
      case "active":
        discordPresenceEverActive = true;
        await invoke("discord_rpc_update", { payload: result.snapshot });
        return "ok";
      case "inactive":
        discordPresenceEverActive = true;
        await invoke("discord_rpc_update", { payload: null });
        return "ok";
      case "unreachable":
        await invoke("discord_rpc_update", { payload: null });
        return "ok";
      case "disconnected":
      case "reauth_required":
        await invoke("discord_rpc_update", { payload: null });
        // A sign-in that lapsed mid-run is worth one mention so the missing
        // presence is not mysterious. A user who never signed in stays silent
        // — they were told how at toggle time.
        if (discordPresenceEverActive && !discordPresenceIssueAlerted) {
          discordPresenceIssueAlerted = true;
          await alert(
            "Discord Rich Presence",
            "Lumiverse's desktop sign-in expired, so Discord presence is paused. Toggle Discord Rich Presence off and on in the tray menu to sign in again.",
          );
        }
        return "needs-auth";
    }
  } catch {
    return "ok";
  }
}

const refreshDiscordPresence = createDiscordPresenceRefreshQueue(pollDiscordPresence);

/**
 * Run the standard desktop OAuth sign-in against the given origin so
 * presence can flow. Opens the system browser — only call from the toggle
 * action, never from a background poll.
 */
async function authorizeDiscordPresence(origin: string): Promise<void> {
  await alert(
    "Discord Rich Presence",
    "Sign in to Lumiverse in your browser so the desktop app can read your active roleplay for Discord presence.",
  );
  // Drop any stale credential for this origin before the fresh sign-in.
  await invoke("remote_instance_disconnect", { origin }).catch(() => {});
  await connectDesktopAuthorization(origin);
}

// ─── System audio for extensions ────────────────────────────────────────────

interface SystemAudioStatus {
  supported: boolean;
  enabled: boolean;
  active: boolean;
}

/** The tray is the native owner of this feature: the switch and the "in use" signal both live here. */
async function renderSystemAudio(status: SystemAudioStatus): Promise<void> {
  await systemAudioItem.setChecked(status.enabled);
  await systemAudioItem.setEnabled(status.supported);
  await systemAudioItem.setText(
    !status.supported
      ? "Extension System Audio (not on this OS yet)"
      : status.active
        ? "Extension Is Analysing System Audio"
        : "Let Extensions Analyse System Audio",
  );
  await trayIcon.setTooltip(status.active ? "Lumiverse: an extension is analysing system audio" : "Lumiverse");
}

async function toggleSystemAudio(): Promise<void> {
  const enable = !settings.systemAudioEnabled;
  if (enable) {
    const allowed = await invoke<boolean>("confirm", {
      title: "Let extensions analyse system audio?",
      message:
        "Extensions you have granted the system audio permission will be able to see levels and a frequency " +
        "spectrum of what this computer is playing, for visualisers and reactive effects. They never receive " +
        "the audio itself.\n\n" +
        "Lumiverse still asks you each time an extension starts, and this menu shows when one is listening. " +
        "Uncheck this item at any time to stop everything.",
      okLabel: "Allow",
      cancelLabel: "Cancel",
    });
    if (!allowed) {
      await systemAudioItem.setChecked(false);
      return;
    }
  }
  await invoke("desktop_system_audio_set_enabled", { enabled: enable });
  settings.systemAudioEnabled = enable;
  await saveSetting("systemAudioEnabled", enable);
}

async function toggleDiscordRpc(): Promise<void> {
  const enabled = !settings.discordRpcEnabled;
  settings.discordRpcEnabled = enabled;
  await discordRpcItem.setChecked(enabled);
  await saveSetting("discordRpcEnabled", enabled);
  await invoke("discord_rpc_set_enabled", { enabled });
  if (enabled) {
    const origin = presenceOrigin();
    if (!origin) {
      await alert(
        "Discord Rich Presence",
        "Presence will start once your Lumiverse server is running. If you are not signed in yet, toggle Discord Rich Presence off and on after it starts to sign in.",
      );
    } else {
      const outcome = await refreshDiscordPresence();
      if (outcome === "needs-auth") {
        await authorizeDiscordPresence(origin);
        await refreshDiscordPresence();
      }
    }
  }
  await updateMenu();
}

// ─── Action wrapper ─────────────────────────────────────────────────────────

function updateMenuInBackground(): void {
  // Menu IPC must not gate server control or prevent an error being shown.
  void updateMenu().catch((error) => console.warn("Unable to update tray menu", error));
}

function action(fn: () => Promise<void>): () => void {
  return () => {
    fn().catch(async (err) => {
      if (!installingDesktopUpdate) busyMessage = null;
      updateMenuInBackground();
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
        await invoke("close_frontend");
      } else {
        await invoke("show_frontend", { port, customUrl: remoteFrontendUrl() });
      }
      await updateFrontendMenuText();
    }),
  });

  openDefaultBrowserItem = await MenuItem.new({
    text: "Open in Default Browser",
    enabled: false,
    action: action(async () => {
      await invoke("open_external_url", { url: frontendUrl() });
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

  remoteAuthItem = await MenuItem.new({
    text: "Authorize Desktop…",
    enabled: false,
    action: action(connectRemoteInstance),
  });
  remoteDisconnectItem = await MenuItem.new({
    text: "Sign Out of Remote Instance",
    enabled: false,
    action: action(disconnectRemoteInstance),
  });

  desktopCaptureItem = await CheckMenuItem.new({
    text: "Let Extensions Capture the Screen",
    checked: false,
    enabled: false,
    action: action(toggleDesktopCapture),
  });

  const setFrontendUrlItem = await MenuItem.new({
    text: "Instance Connection…",
    action: action(async () => {
      await invoke("show_frontend_url_settings");
    }),
  });

  floatingWidgetsItem = await Submenu.new({
    text: "Floating Widgets",
    items: [],
  });
  await updateFloatingWidgetMenu();

  frontendItem = await Submenu.new({
    text: "Browser",
    items: [
      openIntegratedBrowserItem,
      reloadIntegratedBrowserItem,
      openDefaultBrowserItem,
      remoteAuthItem,
      remoteDisconnectItem,
      await PredefinedMenuItem.new({ item: "Separator" }),
      setFrontendUrlItem,
      ...(isLinux ? [await MenuItem.new({ text: "Linux Graphics & Diagnostics…", action: action(async () => { await invoke("show_linux_settings"); }) })] : []),
    ],
  });

  statsPortItem = await MenuItem.new({ text: "Port: —", enabled: false });
  statsPidItem = await MenuItem.new({ text: "PID: —", enabled: false });
  statsUptimeItem = await MenuItem.new({ text: "Uptime: —", enabled: false });
  statsBranchItem = await MenuItem.new({ text: "Branch: —", enabled: false });
  statsVersionItem = await MenuItem.new({ text: "Version: —", enabled: false });
  remoteAccessItem = await CheckMenuItem.new({
    text: "Allow Remote Access", checked: false, enabled: false,
    action: action(toggleRemoteAccess),
  });
  const statsSubmenu = await Submenu.new({
    text: "Serving Stats",
    items: [statsPortItem, statsPidItem, statsUptimeItem, statsBranchItem, statsVersionItem,
      await PredefinedMenuItem.new({ item: "Separator" }), remoteAccessItem],
  });

  checkUpdatesItem = await MenuItem.new({
    text: "Check for Updates",
    action: action(() => checkForUpdates(true)),
  });
  applyUpdateItem = await MenuItem.new({ text: "Apply Update", enabled: false, action: action(applyUpdate) });
  rebuildDesktopItem = await MenuItem.new({
    text: "Rebuild Desktop App…",
    enabled: false,
    action: action(rebuildDesktop),
  });

  autoStartItem = await CheckMenuItem.new({
    text: "Start Local Server at Launch",
    checked: settings.autoStartServer,
    action: action(async () => {
      settings.autoStartServer = !settings.autoStartServer;
      await autoStartItem.setChecked(settings.autoStartServer);
      await saveSetting("autoStartServer", settings.autoStartServer);
    }),
  });
  discordRpcItem = await CheckMenuItem.new({
    text: "Discord Rich Presence",
    checked: settings.discordRpcEnabled,
    action: action(toggleDiscordRpc),
  });
  systemAudioItem = await CheckMenuItem.new({
    text: "Let Extensions Analyse System Audio",
    checked: false,
    action: action(toggleSystemAudio),
  });
  loginItem = await CheckMenuItem.new({
    text: "Launch at Login",
    checked: desktopProfile.isolated ? false : await autostartEnabled().catch(() => false),
    enabled: !desktopProfile.isolated,
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

  openDataFolderItem = await MenuItem.new({
    text: "Open Lumiverse Data Folder",
    enabled: false,
    action: action(async () => {
      if (isRemoteMode() || busyMessage) return;
      await invoke("open_lumiverse_data_folder", { source: client.source, repoDir, bunPath });
    }),
  });

  desktopCheckItem = await MenuItem.new({ text: "Check for Desktop Updates", action: action(() => checkDesktopUpdates(true)) });
  desktopInstallItem = await MenuItem.new({ text: "Install Desktop Update…", enabled: false, action: action(applyDesktopUpdate) });
  stableUpdatesItem = await CheckMenuItem.new({ text: "Stable", checked: desktopUpdateChannel === "stable", action: action(() => selectDesktopUpdateChannel("stable")) });
  nightlyUpdatesItem = await CheckMenuItem.new({ text: "Nightly", checked: desktopUpdateChannel === "nightly", action: action(() => selectDesktopUpdateChannel("nightly")) });
  desktopUpdatesItem = await Submenu.new({
    text: "Desktop Updates",
    items: [
      await MenuItem.new({ text: `Installed: ${desktopUpdateInfo.version}`, enabled: false }),
      ...(desktopUpdateInfo.reason ? [await MenuItem.new({ text: desktopUpdateInfo.reason, enabled: false })] : []),
      desktopCheckItem, desktopInstallItem,
      await Submenu.new({ text: "Update Channel", items: [stableUpdatesItem, nightlyUpdatesItem] }),
    ],
  });

  const quitItem = await MenuItem.new({ text: "Quit Lumiverse", action: action(quit) });
  const separator = () => PredefinedMenuItem.new({ item: "Separator" });

  const menu = await Menu.new({
    items: [
      statusItem,
      await separator(),
      startStopItem,
      frontendItem,
      floatingWidgetsItem,
      statsSubmenu,
      await separator(),
      checkUpdatesItem,
      applyUpdateItem,
      rebuildDesktopItem,
      desktopUpdatesItem,
      await separator(),
      autoStartItem,
      discordRpcItem,
      systemAudioItem,
      desktopCaptureItem,
      loginItem,
      openDataFolderItem,
      await separator(),
      quitItem,
    ],
  });

  trayIcon = await TrayIcon.new({
    id: "lumiverse-tray",
    icon: await loadTrayImage(),
    iconAsTemplate: isMac,
    tooltip: "Lumiverse",
    menu,
    showMenuOnLeftClick: true,
  });
}

async function toggleServer(): Promise<void> {
  if (isRemoteMode()) return;
  if (serverState === "running" || serverState === "starting") {
    await stopServer();
  } else {
    await startServer();
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

/** Serialize selections so a slow shutdown cannot overwrite a later choice. */
function changeInstanceConnection(selection: InstanceConnectionChange): Promise<void> {
  desktopCaptureSwitching++;
  const task = connectionChange.then(() => applyInstanceConnection(selection)).finally(() => { desktopCaptureSwitching--; });
  connectionChange = task.catch(() => {});
  return task;
}

async function applyInstanceConnection(selection: InstanceConnectionChange): Promise<void> {
  if (installingDesktopUpdate) throw new Error("Wait for the desktop update to finish before changing instances.");
  let source = client.source;
  let checkout = repoDir;
  let checkoutBun = bunPath;
  if (selection.connection.mode === "local") {
    source = selection.localServerSource ?? source;
    if (source !== "bundled" && source !== "checkout") throw new Error("Choose a built-in server or an existing checkout.");
    if (source === "bundled" && !bundledServerAvailable) throw new Error("This app does not include a built-in server. Choose a checkout or remote instance.");
    if (source === "checkout") {
      checkout = selection.repoDir ?? repoDir ?? settings.repoDir;
      if (!checkout || !(await invoke<boolean>("validate_repo", { path: checkout }))) {
        throw new Error("Choose an existing Lumiverse checkout containing scripts/runner.ts.");
      }
      checkoutBun = selection.bunPath ?? bunPath ?? settings.bunPath ?? await invoke<string | null>("resolve_bun");
      if (!checkoutBun) throw new Error("Bun was not found. Install Bun to run your existing checkout, or choose the built-in server.");
    }
  }

  await cancelRemoteAuthorization();
  remoteAuthorizationLastId = null;
  remoteAuthorizationLastOrigin = null;
  await invoke("desktop_capture_disconnect");
  openIntegratedBrowserWhenReady = false;
  if (selection.connection.mode === "remote") {
    if (!isRemoteMode() && await client.alive()) await shutdownRunner();
  } else {
    await client.select(source, source === "checkout" && (checkout !== repoDir || checkoutBun !== bunPath));
    settings.localServerSource = source;
    await saveSetting("localServerSource", source);
    if (source === "checkout") {
      repoDir = checkout;
      bunPath = checkoutBun;
      settings.repoDir = checkout;
      settings.bunPath = checkoutBun;
      await saveSetting("repoDir", checkout);
      await saveSetting("bunPath", checkoutBun);
    }
    serverState = "stopped";
    lastStatus = null;
    externalRunning = false;
    updateState = { available: false, commitsBehind: 0, latestMessage: "" };
    desktopShellStale = false;
    desktopShellNoticeShown = false;
  }
  if (instanceConnection.mode === "remote") {
    settings.savedRemoteConnection = instanceConnection;
    await saveSetting("savedRemoteConnection", instanceConnection);
  }
  instanceConnection = selection.connection;
  remoteSnapshot = null;
  settings.instanceConnection = selection.connection;
  settings.instanceConnectionConfigured = true;
  await saveSetting("instanceConnection", selection.connection);
  if (selection.connection.mode === "local") {
    await startServer();
  } else {
    const selectedOrigin = selection.connection.origin;
    settings.savedRemoteConnection = selection.connection;
    await saveSetting("savedRemoteConnection", selection.connection);
    void pollRemoteInstance().then(async () => {
      if (instanceConnection.mode !== "remote" || instanceConnection.origin !== selectedOrigin) return;
      if (remoteSnapshot?.state === "disconnected" || remoteSnapshot?.state === "reauth_required") await connectRemoteInstance();
      if (instanceConnection.mode === "remote" && instanceConnection.origin === selectedOrigin) {
        await invoke("show_frontend", { port, customUrl: remoteFrontendUrl() });
      }
    }).catch(async (error) => {
      await alert("Lumiverse", error instanceof Error ? error.message : String(error), true);
    });
  }
  void refreshDiscordPresence();
  await updateMenu();
}

async function tick(): Promise<void> {
  if (changingNetworkAccess) { await updateMenu(); return; }
  if (!settings.instanceConnectionConfigured) { await updateMenu(); return; }
  // Presence rides the shared tick; its polling handles its own errors.
  void refreshDiscordPresence();
  if (isRemoteMode()) {
    await pollRemoteInstance();
    await updateMenu();
    return;
  }
  if (await client.alive()) {
    await refreshStatus();
    if (externalRunning || (!usesBundledServer() && (serverState === "stopped" || serverState === "crashed"))) {
      await detectExternalServer();
    }
  } else {
    await refreshNetworkAccess();
    await detectExternalServer();
  }
  await updateMenu();
}

async function boot(): Promise<void> {
  settings = await loadSettings();
  await listen<string>("desktop-keybinding-action", ({ payload }) => {
    void (async () => {
      if (payload === "desktop:toggle-window") {
        if (await invoke<boolean>("frontend_visible")) await (await WebviewWindow.getByLabel("frontend"))?.hide();
        else await invoke("show_frontend", { port, customUrl: remoteFrontendUrl() });
      } else if (payload === "desktop:show-window") {
        await invoke("show_frontend", { port, customUrl: remoteFrontendUrl() });
      } else if (payload === "desktop:reload") {
        await invoke("reload_frontend");
      } else if (payload === "desktop:stop-capture") {
        await disableDesktopCapture();
      }
      await updateMenu();
    })().catch(error => console.error("Desktop key binding failed", error));
  });
  desktopUpdateInfo = await invoke<DesktopUpdateInfo>("desktop_update_info");
  desktopUpdateChannel = settings.desktopUpdateChannel === "stable" || settings.desktopUpdateChannel === "nightly"
    ? settings.desktopUpdateChannel : desktopUpdateInfo.defaultChannel;
  desktopProfile = await invoke("desktop_profile_info");
  instanceConnection = settings.instanceConnection;
  bundledServerAvailable = await invoke<boolean>("bundled_server_available");
  settings.localServerSource = resolveLocalServerSource(settings.localServerSource, settings.repoDir, bundledServerAvailable);

  await listen<string>("desktop-capture-setup-requested", ({ payload }) => {
    void (async () => {
      try {
        if (payload !== new URL(frontendUrl()).origin) return;
        await enableDesktopCapture();
        await updateMenu();
      } catch (error) { await alert("Screen capture setup", String(error), true); }
      finally { await invoke("desktop_capture_setup_finished"); }
    })();
  });
  await listen<SystemAudioStatus>("desktop-system-audio-state", ({ payload }) => {
    void renderSystemAudio(payload).catch((error) => console.warn("Unable to show system audio state", error));
  });
  await listen<{ version: string; downloaded: number; total: number | null }>("desktop-update-progress", ({ payload }) => {
    if (!installingDesktopUpdate || payload.version !== desktopReleaseUpdate?.version) return;
    busyMessage = payload.total
      ? `Downloading desktop update: ${Math.min(100, Math.round(payload.downloaded * 100 / payload.total))}%`
      : `Downloading desktop update: ${Math.round(payload.downloaded / 1024 / 1024)} MB`;
    updateMenuInBackground();
  });

  await listen<{ origin: string }>("discord-presence-changed", ({ payload }) => {
    if (payload?.origin === presenceOrigin()) void refreshDiscordPresence();
  });

  await listen<string>("remote-authorization-retry", ({ payload }) => {
    const origin = remoteAuthorizationLastOrigin;
    if (remoteAuthorizationLastId !== payload || !origin || new URL(frontendUrl()).origin !== origin) return;
    action(async () => { await cancelRemoteAuthorization(); await connectDesktopAuthorization(origin); })();
  });
  await listen<InstanceConnectionChange>("instance-connection-changed", ({ payload }) => {
    action(() => changeInstanceConnection(payload))();
  });
  await listen<DesktopWidgetCatalogEntry[]>("desktop-widget-catalog", ({ payload }) => {
    desktopWidgetCatalog = Array.isArray(payload) ? payload : [];
    const catalogIds = new Set(desktopWidgetCatalog.map((widget) => widget.id));
    for (const widgetId of poppedOutWidgetIds) {
      if (!catalogIds.has(widgetId)) poppedOutWidgetIds.delete(widgetId);
    }
    void updateFloatingWidgetMenu().catch((error) => {
      console.warn("Unable to update floating-widget menu", error);
    });
  });
  await listen<DesktopWidgetPopoutState>("desktop-widget-popout-state", ({ payload }) => {
    if (!payload || typeof payload.id !== "string" || typeof payload.poppedOut !== "boolean") return;
    if (payload.poppedOut) {
      poppedOutWidgetIds.add(payload.id);
    } else {
      poppedOutWidgetIds.delete(payload.id);
    }
    void updateFloatingWidgetMenu().catch((error) => {
      console.warn("Unable to update floating-widget state", error);
    });
  });

  await client.init(settings.localServerSource);
  client.onState = (state) => {
    serverState = state;
    if (state === "running" && openIntegratedBrowserWhenReady) {
      openIntegratedBrowserWhenReady = false;
      void refreshStatus()
        .then(() => invoke("show_frontend", { port, customUrl: remoteFrontendUrl() }))
        .catch((err) => alert("Lumiverse", err instanceof Error ? err.message : String(err), true));
    } else if (state === "stopped" || state === "crashed") {
      openIntegratedBrowserWhenReady = false;
      // The instance cannot serve a presence snapshot anymore — clear now
      // rather than waiting for the next tick.
      void refreshDiscordPresence();
    }
    if (!installingDesktopUpdate && !changingNetworkAccess && (state === "running" || state === "stopped" || state === "crashed")) {
      busyMessage = null;
    }
    // Re-check on every start, not just the first. The checkout can move
    // underneath a long-running tray — a git pull outside the app is the most
    // likely way a desktop change arrives, and it fires no event here. A
    // latch would mean the notice waited for the next app launch. The cost is
    // three git commands, and the dialog is gated on the stale transition
    // rather than on this call, so restarting the server cannot nag.
    if (state === "running") {
      void refreshDesktopShellState();
    }
    void refreshStatus().then(updateMenu);
  };
  client.onProgress = (_operation, progressText) => {
    if (installingDesktopUpdate) return;
    busyMessage = progressText;
    void updateMenu();
  };
  client.onExit = () => {
    serverState = "stopped";
    lastStatus = null;
    if (!installingDesktopUpdate && !changingNetworkAccess) busyMessage = null;
    void refreshDiscordPresence();
    void updateMenu();
  };

  // Stored choice first; otherwise discover the checkout this build
  // lives inside (dev builds run from <repo>/desktop/src-tauri/target).
  // Nothing is baked in at build time — installed copies with no stored
  // setting start unconfigured and ask for an explicit selection.
  const candidateRepo = settings.repoDir ?? (!bundledServerAvailable ? await invoke<string | null>("discover_repo") : null);
  repoDir =
    candidateRepo && (await invoke<boolean>("validate_repo", { path: candidateRepo }))
      ? candidateRepo
      : null;
  bunPath = settings.bunPath ?? (!usesBundledServer() ? await invoke<string | null>("resolve_bun") : null);
  if (repoDir) settings.instanceConnectionConfigured = true;
  if (!usesBundledServer() && !repoDir && !isRemoteMode()) settings.instanceConnectionConfigured = false;

  await refreshNetworkAccess();
  await buildTray();
  await updateMenu();
  void checkDesktopUpdates();
  setInterval(() => { void checkDesktopUpdates(); }, 6 * 60 * 60 * 1000);
  // Restore the owner's saved choice, then show what is really true (an unsupported OS stays off).
  if (settings.systemAudioEnabled) {
    await invoke("desktop_system_audio_set_enabled", { enabled: true }).catch(async (error) => {
      console.warn("Unable to resume system audio for extensions", error);
      settings.systemAudioEnabled = false;
      await saveSetting("systemAudioEnabled", false);
    });
  }
  await renderSystemAudio(await invoke<SystemAudioStatus>("desktop_system_audio_status"));
  if (settings.discordRpcEnabled) {
    await invoke("discord_rpc_set_enabled", { enabled: true }).catch((error) => {
      console.warn("Unable to resume Discord Rich Presence", error);
    });
    void refreshDiscordPresence();
  }
  await invoke("desktop_startup_ready");
  const updateResume = await invoke<DesktopUpdateResume | null>("take_desktop_update_resume");
  if (!isRemoteMode() && updateResume?.localPort && Number.isInteger(updateResume.localPort) && updateResume.localPort > 0 && updateResume.localPort <= 65535) {
    port = updateResume.localPort;
  }

  if (isRemoteMode()) {
    void pollRemoteInstance().then(updateMenu).catch((error) => {
      console.warn("Unable to restore remote instance authorization", error);
    });
  }
  action(async () => {
    await restoreDesktopSession(updateResume, {
      remote: isRemoteMode(),
      canStartServer: usesBundledServer() || Boolean(repoDir && bunPath),
      autoStartServer: settings.autoStartServer,
      connectionChosen: settings.instanceConnectionConfigured,
    }, {
      startServer,
      detectExternalServer: async () => {
        if (!usesBundledServer() && repoDir && bunPath) {
          await ensureRunner();
          await refreshStatus();
        }
        await detectExternalServer();
      },
      showFrontend: async () => {
        await invoke("show_frontend", { port, customUrl: remoteFrontendUrl() });
      },
      chooseConnection: async () => { await invoke("show_frontend_url_settings"); },
    });
    await updateMenu();
  })();

  setInterval(() => void tick(), POLL_INTERVAL_MS);
}

async function reportBootFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Lumiverse Desktop failed before its tray was ready", error);

  try {
    await alert(
      "Lumiverse Desktop failed to start",
      `${message}\n\nLaunch the app from a terminal to capture additional diagnostics.`,
      true,
    );
  } catch (alertError) {
    console.error("Unable to show the desktop startup error", alertError);
  } finally {
    // A failed tray bootstrap otherwise leaves only the invisible host window
    // running, making every later launch look like it did nothing.
    await invoke("quit_app").catch((quitError) => {
      console.error("Unable to exit after the desktop startup failure", quitError);
    });
  }
}

void boot().catch(reportBootFailure);
