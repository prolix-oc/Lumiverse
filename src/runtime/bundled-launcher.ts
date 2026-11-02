import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { defaultBundleDirectories, parseBundleOptions, validatePort, validateSettings, type ServerBundleManifest } from "./bundle";
import { extractServerBundle } from "./bundle-cache";
import { configureBundleOwner, hasConfiguredOwner, openBundleBrowser, startBundleSetup, writeBundleSettings, type BundleSetup } from "./bundle-setup";
import { BundleDesktopChannel } from "./bundle-desktop";

const USAGE = `Lumiverse Server (experimental bundled distribution)

Usage: lumiverse-server [options]

Launch with no arguments to configure and open Lumiverse in your browser.

  --data-dir PATH       Use an existing instance or choose a new data folder
  --config-dir PATH     Override the location of server.json
  --cache-dir PATH      Override the extracted runtime cache
  --port NUMBER         Override the saved server port
  --host ADDRESS        Override the bind address (default: 127.0.0.1)
  --env-file PATH       Load an explicit environment file (existing env wins)
  --no-open             Print URLs without opening a browser
  --check               Check native libraries, database subprocesses, and workers
  --reset-password      Reset the owner password interactively
  --print-data-dir      Print the configured data path as JSON without starting
  --network-access MODE Read (status) or save (on/off) access from other devices
  --version             Print build information
  --help                Show this help

No system Bun, Node.js, Git checkout, or package installation is needed to serve.
Git-based extensions, MCP programs, and SMART monitoring use external tools.
`;

export async function runBundledServer(archive: string, manifest: ServerBundleManifest): Promise<void> {
  const options = parseBundleOptions(process.argv.slice(2));
  if (options.command === "help") { console.log(USAGE); return; }
  if (options.command === "version") {
    console.log(`Lumiverse ${manifest.version} (${manifest.platform}-${manifest.arch}, Bun ${manifest.bunVersion}, ${manifest.commit})`);
    return;
  }
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error("This server artifact does not match this operating system and architecture.");
  if (options.envFile) {
    const values = parseEnv(readFileSync(resolve(options.envFile), "utf8"));
    for (const [key, value] of Object.entries(values)) if (!(key in process.env)) process.env[key] = value;
  }
  const defaults = defaultBundleDirectories();
  const configDir = resolve(options.configDir || process.env.LUMIVERSE_CONFIG_DIR || defaults.config);
  const cacheDir = resolve(options.cacheDir || process.env.LUMIVERSE_CACHE_DIR || defaults.cache);
  const settingsPath = join(configDir, "server.json");
  const saved = existsSync(settingsPath) ? validateSettings(JSON.parse(readFileSync(settingsPath, "utf8"))) : undefined;
  let settings = validateSettings({
    format: 1 as const,
    dataDir: resolve(options.dataDir || process.env.DATA_DIR || saved?.dataDir || defaults.data),
    port: options.port ?? validatePort(process.env.PORT || saved?.port || 7860),
    host: options.host || process.env.LUMIVERSE_HOST || saved?.host || "127.0.0.1",
  });
  // The desktop can open the correct folder before first launch or while the
  // server is stopped. Resolve settings without unpacking or touching the data.
  if (options.command === "data-dir") { console.log(JSON.stringify(settings.dataDir)); return; }
  if (options.command === "network-access") {
    const overridden = Boolean(options.host || process.env.LUMIVERSE_HOST);
    if (options.networkAccess !== "status") {
      if (!saved) throw new Error("Set up the built-in server before changing network access.");
      if (overridden) throw new Error("Network access is controlled by --host or LUMIVERSE_HOST. Remove that override before changing the saved setting.");
      // Only change the saved listener. Environment/CLI data and port overrides
      // must never be persisted as a side effect, or initialize another account.
      settings = { ...saved, host: options.networkAccess === "on" ? "::" : "127.0.0.1" };
      writeBundleSettings(settingsPath, settings);
    }
    const host = settings.host.toLowerCase();
    console.log(JSON.stringify({ configured: Boolean(saved), host: settings.host, overridden,
      enabled: !["localhost", "::1", "[::1]"].includes(host) && !/^127\./.test(host) }));
    return;
  }
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const root = await extractServerBundle(archive, manifest, cacheDir);
  let setup: BundleSetup | undefined;
  let child: Bun.Subprocess | undefined;
  let desktop: BundleDesktopChannel | undefined;
  let readyToken = "";
  let stopping = false;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    stopping = true;
    setup?.stop();
    if (!child) process.exit(desktop ? 0 : signal === "SIGINT" ? 130 : 143);
    if (options.command === "serve") {
      try { child.send({ type: "bundle-shutdown", token: readyToken }); }
      catch { child.kill(signal); }
    } else child.kill(signal);
    forceStop ??= setTimeout(() => {
      if (process.platform !== "win32") { try { process.kill(-child!.pid, "SIGKILL"); } catch {} }
      else { try { Bun.spawnSync(["taskkill", "/PID", String(child!.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }); } catch {} }
      child!.kill("SIGKILL");
    }, 20_000);
    forceStop.unref();
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  // The owning desktop process can stop the sidecar gracefully on Windows,
  // where killing a subprocess does not deliver a POSIX termination signal.
  const onParentMessage = (message: unknown) => {
    if ((message as { type?: string } | null)?.type === "lumiverse-shutdown") stop("SIGTERM");
  };
  const onParentDisconnect = () => stop("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  if (typeof process.send === "function") {
    process.on("message", onParentMessage);
    process.on("disconnect", onParentDisconnect);
  }
  let checkData: string | undefined;
  try {
    if (options.desktop) desktop = new BundleDesktopChannel(settings, manifest,
      (selected, username, password) => configureBundleOwner(selected, settingsPath, username, password), () => stop("SIGTERM"));
    if (options.command === "serve" && !hasConfiguredOwner(settings.dataDir)) {
      if (process.env.OWNER_PASSWORD) {
        await configureBundleOwner(settings, settingsPath, process.env.OWNER_USERNAME || "admin", process.env.OWNER_PASSWORD);
      } else if (desktop) {
        desktop.needsSetup();
        settings = await desktop.configuration;
      } else {
        setup = startBundleSetup(settings, settingsPath);
        console.log(`[bundle] Set up Lumiverse: ${setup.url}`);
        if (options.open) openBundleBrowser(setup.url);
        settings = await setup.settings;
      }
    }
    if (options.command === "check") checkData = mkdtempSync(join(root, ".check-"));
    const dataDir = checkData || settings.dataDir;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    readyToken = randomBytes(32).toString("hex");
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      NODE_ENV: "production",
      BUN_OPTIONS: `${process.env.BUN_OPTIONS || ""} --no-env-file`,
      PATH: [join(root, "bin"), process.env.PATH, join(root, "compat")].filter(Boolean).join(delimiter),
      DATA_DIR: dataDir,
      PORT: String(settings.port),
      LUMIVERSE_HOST: settings.host,
      FRONTEND_DIR: process.env.FRONTEND_DIR || join(root, "app", "frontend", "dist"),
      LUMIVERSE_BUNDLE_ID: manifest.payloadSha256,
      LUMIVERSE_BUNDLE_BRANCH: manifest.branch,
      LUMIVERSE_BUNDLE_COMMIT: manifest.commit,
      LUMIVERSE_BUNDLE_READY_TOKEN: readyToken,
      LUMIVERSE_BUNDLE_FFMPEG: manifest.ffmpeg ? "1" : "0",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(dataDir, ".bun-transpiler-cache"),
    };
    // Setup secrets are never passed to extensions or retained in the serving process.
    delete childEnv.OWNER_PASSWORD;
    delete childEnv.BUN_BE_BUN;
    delete childEnv.LUMIVERSE_DESKTOP_CHANNEL_TOKEN;
    for (const key of Object.keys(childEnv)) if (key !== "PATH" && key.toLowerCase() === "path") delete childEnv[key];
    const entry = options.command === "check" ? "src/runtime/bundled-check.ts"
      : options.command === "reset-password" ? "scripts/reset-password.ts" : "src/index.ts";
    let ready = false;
    const browserHost = ["::", "0.0.0.0"].includes(settings.host) ? "127.0.0.1" : settings.host.includes(":") ? `[${settings.host}]` : settings.host;
    const browserUrl = `${process.env.LUMIVERSE_TLS_CERT_FILE || process.env.LUMIVERSE_TLS_CONFIG_FILE ? "https" : "http"}://${browserHost}:${settings.port}/`;
    child = Bun.spawn({
      cmd: [join(root, "bin", process.platform === "win32" ? "bun.exe" : "bun"),
        ...(["false", "0"].includes(process.env.LUMIVERSE_SMOL || "") ? [] : ["--smol"]), join(root, "app", entry)],
      env: childEnv, stdin: desktop ? "ignore" : "inherit", stdout: "inherit", stderr: "inherit",
      detached: !desktop && process.platform !== "win32",
      ipc(message) {
        if (message?.type !== "bundle-ready" || message.token !== readyToken || ready) return;
        if (stopping) { child!.send({ type: "bundle-shutdown", token: readyToken }); return; }
        ready = true;
        console.log(`[bundle] Open Lumiverse: ${browserUrl}`);
        process.send?.({ type: "lumiverse-ready", url: browserUrl });
        desktop?.ready(browserUrl, child!.pid);
        if (setup) setup.ready(browserUrl);
        else if (options.open) openBundleBrowser(browserUrl);
      },
    });
    const exitCode = await child.exited;
    if (exitCode !== 0 && !ready && setup) {
      setup.failed(`Lumiverse could not start (exit ${exitCode}). Check the server output, then launch again.`);
      await Bun.sleep(2000);
    }
    process.exitCode = exitCode;
  } finally {
    if (forceStop) clearTimeout(forceStop);
    setup?.stop();
    desktop?.close();
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.off("message", onParentMessage);
    process.off("disconnect", onParentDisconnect);
    if (process.connected) process.disconnect?.();
    if (checkData) rmSync(checkData, { recursive: true, force: true });
  }
}
