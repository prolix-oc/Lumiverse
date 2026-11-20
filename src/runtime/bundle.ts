import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";

export interface ServerBundleManifest {
  format: 1;
  version: string;
  bunVersion: string;
  platform: string;
  arch: string;
  branch: string;
  commit: string;
  payloadSha256: string;
  executableFiles: string[];
  requiredFiles: string[];
  ffmpeg: boolean;
}

export interface BundledServerSettings {
  format: 1;
  dataDir: string;
  port: number;
  host: string;
}

export interface BundleOptions {
  command: "serve" | "check" | "reset-password" | "data-dir" | "network-access" | "help" | "version";
  networkAccess?: "on" | "off" | "status";
  dataDir?: string;
  cacheDir?: string;
  configDir?: string;
  port?: number;
  host?: string;
  envFile?: string;
  open: boolean;
  desktop: boolean;
}

export function parseBundleOptions(args: string[]): BundleOptions {
  const options: BundleOptions = { command: "serve", open: true, desktop: false };
  const commands = new Map<string, BundleOptions["command"]>([
    ["--help", "help"], ["-h", "help"], ["--version", "version"],
    ["--check", "check"], ["--reset-password", "reset-password"],
    ["--print-data-dir", "data-dir"],
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (commands.has(arg)) {
      if (options.command !== "serve") throw new Error("Choose one command at a time.");
      options.command = commands.get(arg)!;
    } else if (arg === "--network-access") {
      if (options.command !== "serve") throw new Error("Choose one command at a time.");
      const value = args[++i];
      if (value !== "on" && value !== "off" && value !== "status") throw new Error("--network-access requires on, off, or status.");
      options.command = "network-access";
      options.networkAccess = value;
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg === "--desktop") {
      options.desktop = true;
      options.open = false;
    } else {
      const key = ({ "--data-dir": "dataDir", "--cache-dir": "cacheDir", "--config-dir": "configDir",
        "--port": "port", "--host": "host", "--env-file": "envFile" } as const)[arg];
      if (!key) throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (key === "port") options.port = validatePort(value);
      else options[key] = value;
    }
  }
  if (options.desktop && options.command !== "serve") throw new Error("Desktop mode requires the serving command.");
  return options;
}

export function validatePort(value: unknown): number {
  const port = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be an integer from 1 to 65535.");
  return port;
}

export function validateSettings(value: unknown): BundledServerSettings {
  const settings = value as Partial<BundledServerSettings> | null;
  if (!settings || settings.format !== 1 || typeof settings.dataDir !== "string" || !settings.dataDir.trim()
    || typeof settings.host !== "string" || !settings.host || settings.host.length > 255 || /[\s/\\]/.test(settings.host)) {
    throw new Error("Invalid bundled server settings.");
  }
  return { format: 1, dataDir: resolve(settings.dataDir), host: settings.host, port: validatePort(settings.port) };
}

export function defaultBundleDirectories(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home = homedir(),
): { config: string; cache: string; data: string } {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
    return { config: win32.join(base, "Lumiverse"), cache: win32.join(base, "Lumiverse", "Cache"), data: win32.join(base, "Lumiverse", "data") };
  }
  if (platform === "darwin") {
    const base = posix.join(home, "Library", "Application Support", "Lumiverse");
    return { config: base, cache: posix.join(home, "Library", "Caches", "Lumiverse"), data: posix.join(base, "data") };
  }
  return {
    config: posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), "lumiverse"),
    cache: posix.join(env.XDG_CACHE_HOME || posix.join(home, ".cache"), "lumiverse"),
    data: posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), "lumiverse", "data"),
  };
}
