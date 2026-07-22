/** Persisted tray settings, stored via tauri-plugin-store in the app data dir. */

import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("settings.json");

export interface TraySettings {
  /** Lumiverse checkout to manage; null = use the build-time default. */
  repoDir: string | null;
  /** Explicit bun binary; null = auto-resolve. */
  bunPath: string | null;
  /** Start the Lumiverse server as soon as the tray app launches. */
  autoStartServer: boolean;
  /** Last frontend window position/size; null = center 1200x800. */
  frontendBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  /** Optional cloud/self-hosted frontend URL; null uses the local runner. */
  customFrontendUrl: string | null;
}

const DEFAULTS: TraySettings = {
  repoDir: null,
  bunPath: null,
  autoStartServer: true,
  frontendBounds: null,
  customFrontendUrl: null,
};

export async function loadSettings(): Promise<TraySettings> {
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as Array<keyof TraySettings>) {
    const value = await store.get(key);
    if (value !== undefined && value !== null) {
      (settings as Record<string, unknown>)[key] = value;
    }
  }
  return settings;
}

export async function saveSetting<K extends keyof TraySettings>(
  key: K,
  value: TraySettings[K],
): Promise<void> {
  await store.set(key, value);
  await store.save();
}
