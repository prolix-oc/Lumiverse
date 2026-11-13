/** Persisted tray settings, stored via tauri-plugin-store in the app data dir. */

import { LazyStore } from "@tauri-apps/plugin-store";
import {
  LOCAL_INSTANCE_CONNECTION,
  savedConnectionPreferences,
  type InstanceConnection,
  type RemoteInstanceConnection,
} from "./instance-connection";
import { type LocalServerSource } from "./local-server";
import { type DesktopUpdateChannel } from "./desktop-updates";

const store = new LazyStore("settings.json");

export interface TraySettings {
  /** Lumiverse checkout to manage; retained when using the built-in server or remote. */
  repoDir: string | null;
  /** Null migrates older settings based on the saved checkout and available runtime. */
  localServerSource: LocalServerSource | null;
  /** Explicit bun binary; null = auto-resolve. */
  bunPath: string | null;
  /** Start the Lumiverse server as soon as the tray app launches. */
  autoStartServer: boolean;
  /** Show the active roleplay in the user's Discord status via Rich Presence. */
  discordRpcEnabled: boolean;
  /** Let extensions the user has granted `system_audio` analyse what this computer plays (levels and spectrum only). */
  systemAudioEnabled: boolean;
  /** Capture remains enabled for this selected instance until explicitly turned off. */
  desktopCaptureOrigin: string | null;
  /** Last frontend window position/size; null = center 1200x800. */
  frontendBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  /** The local runner or one explicitly selected remote Lumiverse instance. */
  instanceConnection: InstanceConnection;
  /** Derived from a persisted choice; a new bundled install asks first. */
  instanceConnectionConfigured: boolean;
  /** Retained while using a local instance; OAuth credentials stay in the native store. */
  savedRemoteConnection: RemoteInstanceConnection | null;
  /** Null uses the channel of the installed desktop release. */
  desktopUpdateChannel: DesktopUpdateChannel | null;
}

const DEFAULTS: TraySettings = {
  repoDir: null,
  localServerSource: null,
  bunPath: null,
  autoStartServer: true,
  discordRpcEnabled: false,
  systemAudioEnabled: false,
  desktopCaptureOrigin: null,
  frontendBounds: null,
  instanceConnection: LOCAL_INSTANCE_CONNECTION,
  instanceConnectionConfigured: false,
  savedRemoteConnection: null,
  desktopUpdateChannel: null,
};

export async function loadSettings(): Promise<TraySettings> {
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS).filter((key) => !["instanceConnection", "instanceConnectionConfigured", "savedRemoteConnection"].includes(key)) as Array<keyof TraySettings>) {
    const value = await store.get(key);
    if (value !== undefined && value !== null) {
      (settings as Record<string, unknown>)[key] = value;
    }
  }
  const savedConnection = await store.get("instanceConnection");
  const legacyUrl = savedConnection == null ? await store.get("customFrontendUrl") : undefined;
  const restored = savedConnectionPreferences(savedConnection, await store.get("savedRemoteConnection"), legacyUrl);
  settings.instanceConnection = restored.connection;
  settings.instanceConnectionConfigured = restored.configured || Boolean(settings.repoDir);
  settings.savedRemoteConnection = restored.remote;
  return settings;
}

export async function saveSetting<K extends keyof TraySettings>(
  key: K,
  value: TraySettings[K],
): Promise<void> {
  await store.set(key, value);
  await store.save();
}
