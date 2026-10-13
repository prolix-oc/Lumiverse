/** Persisted tray settings, stored via tauri-plugin-store in the app data dir. */

import { LazyStore } from "@tauri-apps/plugin-store";
import {
  LOCAL_INSTANCE_CONNECTION,
  normalizeInstanceConnection,
  type InstanceConnection,
} from "./instance-connection";

const store = new LazyStore("settings.json");

export interface TraySettings {
  /** Lumiverse checkout to manage; null = use the build-time default. */
  repoDir: string | null;
  /** Explicit bun binary; null = auto-resolve. */
  bunPath: string | null;
  /** Start the Lumiverse server as soon as the tray app launches. */
  autoStartServer: boolean;
  /** Show the active roleplay in the user's Discord status via Rich Presence. */
  discordRpcEnabled: boolean;
  /** Last frontend window position/size; null = center 1200x800. */
  frontendBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  /** The local runner or one explicitly selected remote Lumiverse instance. */
  instanceConnection: InstanceConnection;
}

const DEFAULTS: TraySettings = {
  repoDir: null,
  bunPath: null,
  autoStartServer: true,
  discordRpcEnabled: false,
  frontendBounds: null,
  instanceConnection: LOCAL_INSTANCE_CONNECTION,
};

export async function loadSettings(): Promise<TraySettings> {
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS).filter((key) => key !== "instanceConnection") as Array<keyof TraySettings>) {
    const value = await store.get(key);
    if (value !== undefined && value !== null) {
      (settings as Record<string, unknown>)[key] = value;
    }
  }
  const savedConnection = await store.get("instanceConnection");
  const legacyUrl = savedConnection == null ? await store.get("customFrontendUrl") : undefined;
  settings.instanceConnection = normalizeInstanceConnection(savedConnection, legacyUrl);
  return settings;
}

export async function saveSetting<K extends keyof TraySettings>(
  key: K,
  value: TraySettings[K],
): Promise<void> {
  await store.set(key, value);
  await store.save();
}
