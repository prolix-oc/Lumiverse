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
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  RunnerClient,
  type DesktopShellState,
  type FullStatus,
  type ServerState,
  type UpdateState,
} from "./runner-client";
import { loadSettings, saveSetting, type TraySettings } from "./settings";
import { restoreDesktopSession, type DesktopUpdateResume } from "./update-resume";
import { type InstanceConnection, LOCAL_INSTANCE_CONNECTION } from "./instance-connection";
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
// The tray is a compiled binary the git update flow cannot replace, so a pull
// carrying desktop changes leaves this process running superseded code.
let desktopShellStale = false;
let desktopShellNoticeShown = false;
let instanceConnection: InstanceConnection = LOCAL_INSTANCE_CONNECTION;
let remoteSnapshot: RemoteInstanceSnapshot | null = null;
let openIntegratedBrowserWhenReady = false;

function isRemoteMode(): boolean {
  return instanceConnection.mode === "remote";
}

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
let checkUpdatesItem: MenuItem;
let applyUpdateItem: MenuItem;
let rebuildDesktopItem: MenuItem;
let autoStartItem: CheckMenuItem;
let loginItem: CheckMenuItem;
let openIntegratedBrowserItem: MenuItem;
let openDefaultBrowserItem: MenuItem;
let reloadIntegratedBrowserItem: MenuItem;
let remoteAuthItem: MenuItem;
let remoteDisconnectItem: MenuItem;
let desktopCaptureItem: MenuItem;
let floatingWidgetsItem: Submenu;

interface DesktopCaptureStatus {
  enabled: boolean;
  origin: string | null;
  capabilities: { image: boolean; video: boolean; replay: boolean };
  error: string | null;
}

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
        return `Signing in to ${name}…`;
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
  const transitioning = serverState === "starting" || serverState === "stopping" || busyMessage !== null;
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
    await startStopItem.setEnabled(!transitioning || serverState === "starting");
  }

  await updateFrontendMenuText();

  await remoteAuthItem.setText(
    remoteSnapshot?.state === "connected" || remoteSnapshot?.state === "restricted"
      ? "Reconnect Remote Instance…"
      : "Sign In to Remote Instance…",
  );
  await remoteAuthItem.setEnabled(remote && remoteSnapshot?.state !== "authorizing");
  await remoteDisconnectItem.setEnabled(
    remote && remoteSnapshot !== null && remoteSnapshot.state !== "disconnected" && remoteSnapshot.state !== "authorizing",
  );

  const capture = await invoke<DesktopCaptureStatus>("desktop_capture_status");
  await desktopCaptureItem.setText(capture.enabled
    ? "Disable Extension Screen Capture"
    : "Enable Extension Screen Capture…");
  await desktopCaptureItem.setEnabled(capture.capabilities.image && !transitioning);

  await statsPortItem.setText(`Port: ${remote ? (remoteSnapshot?.status?.port ?? "—") : port}`);
  await statsPidItem.setText(`PID: ${remote ? (remoteSnapshot?.status?.pid ?? "—") : (lastStatus?.pid ?? "—")}`);
  await statsUptimeItem.setText(`Uptime: ${remote
    ? formatElapsed(remoteSnapshot?.status?.uptime)
    : (running ? formatUptime(lastStatus?.startedAt ?? null) : "—")}`);
  await statsBranchItem.setText(`Branch: ${remote ? (remoteSnapshot?.status?.branch ?? "—") : (lastStatus?.branch ?? "—")}`);
  await statsVersionItem.setText(`Version: ${remote ? (remoteSnapshot?.status?.version ?? "—") : (lastStatus?.version ?? "—")}`);

  await checkUpdatesItem.setEnabled(!remote && !busyMessage && !externalRunning);
  // The rebuild compiles from the configured checkout, so it needs one — but
  // unlike the update items it stays available when a server is running
  // externally, since it neither stops nor talks to that server.
  await rebuildDesktopItem.setEnabled(!busyMessage && repoDir !== null);
  if (updateState.available) {
    await applyUpdateItem.setText(`Apply Update (${updateState.commitsBehind} behind)`);
    await applyUpdateItem.setEnabled(!remote && !busyMessage && !externalRunning);
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

async function startServer(reopenFrontend = true): Promise<void> {
  if (isRemoteMode()) throw new Error("Switch to the local instance before starting its server.");
  await ensureRunner();
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

/**
 * Ask the checkout whether it has moved past the desktop sources this binary
 * was compiled from. Only the checkout can answer — the shell knows just the
 * revision stamped into it at build time.
 */
async function refreshDesktopShellState(): Promise<void> {
  if (!repoDir || !(await client.alive())) return;

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
      await revealItemInDir(result.bundlePath).catch(() => {});
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
      await revealItemInDir(result.bundlePath).catch(() => {});
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
      await revealItemInDir(result.bundlePath).catch(() => {});
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
  await saveSetting("instanceConnection", instanceConnection);
}

async function pollRemoteInstance(): Promise<void> {
  if (instanceConnection.mode !== "remote" || remoteSnapshot?.state === "authorizing") return;
  const origin = instanceConnection.origin;
  const snapshot = await invoke<RemoteInstanceSnapshot>("remote_instance_poll", {
    origin,
  });
  if (instanceConnection.mode !== "remote" || instanceConnection.origin !== origin) return;
  remoteSnapshot = snapshot;
  await persistRemoteIdentity(snapshot);
}

async function connectRemoteInstance(): Promise<void> {
  if (instanceConnection.mode !== "remote" || remoteSnapshot?.state === "authorizing") return;
  const origin = instanceConnection.origin;
  remoteSnapshot = pendingRemoteSnapshot(origin);
  await updateMenu();
  try {
    const snapshot = await invoke<RemoteInstanceSnapshot>("remote_instance_connect", { origin });
    if (instanceConnection.mode !== "remote" || instanceConnection.origin !== origin) {
      // The selection changed while the system browser was open. Remove the
      // just-created credential instead of attaching it to an abandoned URL.
      await invoke("remote_instance_disconnect", { origin }).catch(() => {});
      return;
    }
    remoteSnapshot = snapshot;
    await persistRemoteIdentity(snapshot);
    if (!snapshot.credentialPersisted) {
      await alert(
        "Lumiverse Desktop",
        "The remote instance is connected for this session, but its refresh credential could not be saved in the operating system credential store. You will need to sign in again after restarting Desktop.",
      );
    }
  } catch (error) {
    if (instanceConnection.mode !== "remote" || instanceConnection.origin !== origin) return;
    remoteSnapshot = {
      ...pendingRemoteSnapshot(origin),
      state: "reauth_required",
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    await updateMenu();
  }
}

async function disconnectRemoteInstance(): Promise<void> {
  if (instanceConnection.mode !== "remote") return;
  await invoke("remote_instance_disconnect", { origin: instanceConnection.origin });
  remoteSnapshot = {
    ...pendingRemoteSnapshot(instanceConnection.origin),
    state: "disconnected",
  };
  await updateMenu();
}

async function toggleDesktopCapture(): Promise<void> {
  const capture = await invoke<DesktopCaptureStatus>("desktop_capture_status");
  if (capture.enabled) {
    await invoke("desktop_capture_disconnect");
  } else {
    const origin = new URL(frontendUrl()).origin;
    await invoke("desktop_capture_connect", { origin });
    if (origin !== new URL(frontendUrl()).origin) {
      await invoke("desktop_capture_disconnect");
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
      busyMessage = null;
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

  remoteAuthItem = await MenuItem.new({
    text: "Sign In to Remote Instance…",
    enabled: false,
    action: action(connectRemoteInstance),
  });
  remoteDisconnectItem = await MenuItem.new({
    text: "Sign Out of Remote Instance",
    enabled: false,
    action: action(disconnectRemoteInstance),
  });

  desktopCaptureItem = await MenuItem.new({
    text: "Enable Extension Screen Capture…",
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
      desktopCaptureItem,
      await PredefinedMenuItem.new({ item: "Separator" }),
      setFrontendUrlItem,
    ],
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
        updateMenuInBackground();
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
      floatingWidgetsItem,
      statsSubmenu,
      await separator(),
      checkUpdatesItem,
      applyUpdateItem,
      rebuildDesktopItem,
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
  if (isRemoteMode()) return;
  if (serverState === "running" || serverState === "starting") {
    await stopServer();
  } else {
    await startServer();
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (isRemoteMode()) {
    await pollRemoteInstance();
    await updateMenu();
    return;
  }
  if (await client.alive()) {
    await refreshStatus();
  } else {
    await detectExternalServer();
  }
  await updateMenu();
}

async function boot(): Promise<void> {
  settings = await loadSettings();
  instanceConnection = settings.instanceConnection;

  await listen<{ connection: InstanceConnection }>("instance-connection-changed", async ({ payload }) => {
    await invoke("desktop_capture_disconnect");
    const previousOrigin = instanceConnection.mode === "remote" ? instanceConnection.origin : null;
    instanceConnection = payload.connection;
    remoteSnapshot = null;
    settings.instanceConnection = payload.connection;
    await saveSetting("instanceConnection", payload.connection);
    if (previousOrigin && (payload.connection.mode !== "remote" || payload.connection.origin !== previousOrigin)) {
      await invoke("remote_instance_disconnect", { origin: previousOrigin }).catch(() => {});
    }
    if (!isRemoteMode()) {
      await refreshStatus();
      await detectExternalServer();
    } else {
      void connectRemoteInstance().catch(async (error) => {
        await alert("Lumiverse", error instanceof Error ? error.message : String(error), true);
      });
    }
    await updateMenu();
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

  await client.init();
  client.onState = (state) => {
    serverState = state;
    if (state === "running" && openIntegratedBrowserWhenReady) {
      openIntegratedBrowserWhenReady = false;
      void refreshStatus()
        .then(() => invoke("show_frontend", { port, customUrl: remoteFrontendUrl() }))
        .catch((err) => alert("Lumiverse", err instanceof Error ? err.message : String(err), true));
    } else if (state === "stopped" || state === "crashed") {
      openIntegratedBrowserWhenReady = false;
    }
    if (state === "running" || state === "stopped" || state === "crashed") {
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
  await invoke("desktop_startup_ready");
  const updateResume = await invoke<DesktopUpdateResume | null>("take_desktop_update_resume");

  if (!repoDir && !isRemoteMode()) {
    await alert(
      "Lumiverse",
      "No Lumiverse folder is configured yet. Choose your Lumiverse checkout via “Set Lumiverse Folder…” in the tray menu.",
    );
  }

  if (isRemoteMode()) {
    void pollRemoteInstance().then(updateMenu).catch((error) => {
      console.warn("Unable to restore remote instance authorization", error);
    });
  }
  action(async () => {
    await restoreDesktopSession(updateResume, {
      remote: isRemoteMode(),
      canStartServer: Boolean(repoDir && bunPath),
      autoStartServer: settings.autoStartServer,
    }, {
      startServer,
      detectExternalServer,
      showFrontend: async () => {
        await invoke("show_frontend", { port, customUrl: remoteFrontendUrl() });
      },
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
