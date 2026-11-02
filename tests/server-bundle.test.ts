import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBundleDirectories, parseBundleOptions, validateSettings, type ServerBundleManifest } from "../src/runtime/bundle";
import { extractServerBundle } from "../src/runtime/bundle-cache";
import { hasConfiguredOwner, startBundleSetup, type BundleSetup } from "../src/runtime/bundle-setup";
import { verifyPassword } from "../src/crypto/password";
import { collectBundleFiles, serverBuildTarget, verifyWindowsRuntime, writeBundleArchive } from "../scripts/build-server";
import { desktopServerTarget } from "../scripts/build-desktop-server";
import { JSDOM } from "jsdom";
import { BUNDLE_SETUP_PAGE } from "../src/runtime/bundle-setup-page";

const temporary: string[] = [];
const listeners: BundleSetup[] = [];
function directory(): string { const path = mkdtempSync(join(tmpdir(), "lumiverse-bundle-test-")); temporary.push(path); return path; }
afterEach(() => { for (const listener of listeners.splice(0)) listener.stop(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("server bundle runtime", () => {
  test("selects ARM64 server, runtime, and sidecar metadata when cross-building Windows", () => {
    expect(serverBuildTarget(undefined, "win32", "x64")).toEqual({ platform: "win32", arch: "x64", cross: false });
    expect(serverBuildTarget("aarch64-pc-windows-msvc", "win32", "x64")).toEqual({ platform: "win32", arch: "arm64", cross: true });
    expect(desktopServerTarget(["--reuse-server", "--target", "aarch64-pc-windows-msvc"], "win32", "x64"))
      .toEqual({ platform: "win32", arch: "arm64", cross: true, target: "aarch64-pc-windows-msvc" });
    expect(desktopServerTarget(["--target=aarch64-pc-windows-msvc"], "win32", "x64").arch).toBe("arm64");
    expect(desktopServerTarget(["--target", "aarch64-apple-darwin"], "darwin", "arm64").cross).toBe(false);
    expect(() => serverBuildTarget("aarch64-pc-windows-msvc", "linux", "x64")).toThrow("Windows");
    expect(() => serverBuildTarget("i686-pc-windows-msvc", "win32", "x64")).toThrow();
    expect(() => desktopServerTarget(["--target"], "win32", "x64")).toThrow("needs");
    expect(() => desktopServerTarget(["--target="], "win32", "x64")).toThrow("needs");
  });

  test("rejects a wrong-architecture or malformed embedded Windows runtime", () => {
    const bytes = new Uint8Array(70);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0x5a4d, true);
    view.setUint32(0x3c, 64, true);
    view.setUint32(64, 0x00004550, true);
    view.setUint16(68, 0xaa64, true);
    expect(() => verifyWindowsRuntime(bytes, "arm64")).not.toThrow();
    expect(() => verifyWindowsRuntime(bytes, "x64")).toThrow("architecture");
    expect(() => verifyWindowsRuntime(bytes.slice(0, 69), "arm64")).toThrow();
    view.setUint32(0x3c, 0xffffffff, true);
    expect(() => verifyWindowsRuntime(bytes, "arm64")).toThrow();
    expect(() => verifyWindowsRuntime(new Uint8Array(), "arm64")).toThrow("header");
  });

  test("archives file bytes rather than empty file-backed blobs", async () => {
    const base = directory();
    writeFileSync(join(base, "binary.node"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(base, "entry.ts"), "console.log('payload')");
    const { files } = collectBundleFiles(base);
    const archive = join(base, "payload.tar.gz");
    await writeBundleArchive(archive, files);
    const bytes = await Bun.file(archive).bytes();
    expect([...bytes.slice(0, 2)]).toEqual([0x1f, 0x8b]);
    const restored = await new Bun.Archive(bytes).files();
    expect(await restored.get("entry.ts")!.text()).toBe("console.log('payload')");
    expect(await restored.get("binary.node")!.bytes()).toEqual(new Uint8Array([0, 1, 2, 255]));
  });

  test("keeps OS data locations independent of the launch directory", () => {
    expect(defaultBundleDirectories({}, "darwin", "/Users/alice").data).toBe("/Users/alice/Library/Application Support/Lumiverse/data");
    expect(defaultBundleDirectories({ LOCALAPPDATA: "C:\\Local" }, "win32", "C:\\Users\\alice").data).toBe("C:\\Local\\Lumiverse\\data");
    expect(defaultBundleDirectories({ XDG_DATA_HOME: "/data", XDG_CACHE_HOME: "/cache" }, "linux", "/home/alice")).toEqual({ data: "/data/lumiverse/data", cache: "/cache/lumiverse", config: "/home/alice/.config/lumiverse" });
  });

  test("rejects malformed port overrides and unknown launcher options", () => {
    for (const port of ["0", "65536", "123abc", "-1", "1.5"]) expect(() => parseBundleOptions(["--port", port])).toThrow();
    expect(() => parseBundleOptions(["--data-dir", "--check"])).toThrow();
    expect(() => parseBundleOptions(["--watch"])).toThrow();
    expect(() => validateSettings({ format: 1, dataDir: "/data", port: 7860, host: "" })).toThrow();
    for (const args of [["--network-access"], ["--network-access", "yes"], ["--check", "--network-access", "on"],
      ["--network-access", "off", "--print-data-dir"], ["--desktop", "--network-access", "status"]]) {
      expect(() => parseBundleOptions(args)).toThrow();
    }
  });

  test("reports the configured data folder without extracting, initializing, or starting the server", async () => {
    const base = realpathSync(directory());
    const config = join(base, "config");
    const cache = join(base, "cache");
    const selected = join(base, "Old Lumiverse Δ");
    const launcher = join(base, "query.ts");
    const manifest: ServerBundleManifest = { format: 1, version: "test", bunVersion: Bun.version,
      platform: process.platform, arch: process.arch, branch: "staging", commit: "test",
      payloadSha256: "0".repeat(64), executableFiles: [], requiredFiles: [], ffmpeg: false };
    writeFileSync(launcher, `import { runBundledServer } from ${JSON.stringify(resolve(import.meta.dir, "../src/runtime/bundled-launcher.ts"))};\nawait runBundledServer("missing-archive", ${JSON.stringify(manifest)});\n`);
    const env = { ...process.env };
    for (const key of ["DATA_DIR", "PORT", "LUMIVERSE_HOST", "BUN_OPTIONS", "LUMIVERSE_CONFIG_DIR", "LUMIVERSE_CACHE_DIR"]) delete env[key];
    const query = async (extra: string[], overrides: Record<string, string> = {}) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", launcher, "--print-data-dir", "--config-dir", config, "--cache-dir", cache, ...extra],
        { cwd: base, env: { ...env, ...overrides }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(existsSync(cache)).toBe(false);
      return JSON.parse(stdout);
    };
    expect(await query(["--data-dir", selected])).toBe(selected);
    expect(existsSync(config)).toBe(false);
    expect(existsSync(selected)).toBe(false);
    mkdirSync(config);
    const saved = JSON.stringify({ format: 1, dataDir: selected, port: 17860, host: "127.0.0.1" });
    writeFileSync(join(config, "server.json"), saved);
    expect(await query([])).toBe(selected);
    expect(await query([], { DATA_DIR: "environment-data" })).toBe(join(base, "environment-data"));
    expect(await query(["--data-dir", "cli-data"], { DATA_DIR: "environment-data" })).toBe(join(base, "cli-data"));
    expect(readFileSync(join(config, "server.json"), "utf8")).toBe(saved);
    expect(existsSync(selected)).toBe(false);
  });

  test("changes saved network access without extracting a runtime or touching an existing account", async () => {
    const base = realpathSync(directory());
    const config = join(base, "config");
    const cache = join(base, "cache");
    const dataDir = join(base, "existing-data");
    const settingsPath = join(config, "server.json");
    const launcher = join(base, "network.ts");
    const manifest: ServerBundleManifest = { format: 1, version: "test", bunVersion: Bun.version,
      platform: process.platform, arch: process.arch, branch: "staging", commit: "test",
      payloadSha256: "0".repeat(64), executableFiles: [], requiredFiles: [], ffmpeg: false };
    writeFileSync(launcher, `import { runBundledServer } from ${JSON.stringify(resolve(import.meta.dir, "../src/runtime/bundled-launcher.ts"))};\nawait runBundledServer("missing-archive", ${JSON.stringify(manifest)});\n`);
    const env = { ...process.env };
    for (const key of ["DATA_DIR", "PORT", "LUMIVERSE_HOST", "BUN_OPTIONS", "LUMIVERSE_CONFIG_DIR", "LUMIVERSE_CACHE_DIR"]) delete env[key];
    const run = async (mode: string, extra: string[] = [], overrides: Record<string, string> = {}) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", launcher, "--config-dir", config, "--cache-dir", cache,
        "--network-access", mode, ...extra], { cwd: base, env: { ...env, ...overrides }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exitCode };
    };
    expect(JSON.parse((await run("status")).stdout)).toEqual({ configured: false, enabled: false, host: "127.0.0.1", overridden: false });
    expect((await run("on")).exitCode).toBe(1);
    expect(existsSync(config)).toBe(false);
    mkdirSync(config);
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "owner.credentials"), "existing owner");
    writeFileSync(join(dataDir, "lumiverse.db"), "existing database");
    const saved = { format: 1, dataDir, port: 17860, host: "127.0.0.1" };
    writeFileSync(settingsPath, JSON.stringify(saved));
    const enabled = await run("on", ["--data-dir", join(base, "override-data"), "--port", "27860"]);
    expect(enabled.exitCode).toBe(0);
    expect(JSON.parse(enabled.stdout)).toEqual({ configured: true, enabled: true, host: "::", overridden: false });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ ...saved, host: "::" });
    expect(JSON.parse((await run("status")).stdout).enabled).toBe(true);
    const beforeOverride = readFileSync(settingsPath, "utf8");
    const overrides: Array<{ extra: string[]; env: Record<string, string> }> = [
      { extra: ["--host", "127.0.0.1"], env: {} }, { extra: [], env: { LUMIVERSE_HOST: "127.0.0.1" } },
    ];
    for (const override of overrides) {
      expect(JSON.parse((await run("status", override.extra, override.env)).stdout))
        .toEqual({ configured: true, enabled: false, host: "127.0.0.1", overridden: true });
      const rejected = await run("off", override.extra, override.env);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toContain("Remove that override");
      expect(readFileSync(settingsPath, "utf8")).toBe(beforeOverride);
    }
    expect((await run("off")).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(saved);
    expect(JSON.parse((await run("status")).stdout).enabled).toBe(false);
    expect(readFileSync(join(dataDir, "owner.credentials"), "utf8")).toBe("existing owner");
    expect(readFileSync(join(dataDir, "lumiverse.db"), "utf8")).toBe("existing database");
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(join(base, "override-data"))).toBe(false);
  });

  test("publishes a complete cache under concurrent extraction and rejects damaged archives", async () => {
    const base = directory();
    const bytes = await new Bun.Archive({ "src/index.ts": "console.log('fixture')", [`runtime/${process.platform === "win32" ? "bun.exe" : "bun"}`]: "runtime fixture" }).bytes();
    const archive = join(base, "app.tar");
    await Bun.write(archive, bytes);
    const manifest: ServerBundleManifest = { format: 1, version: "test", bunVersion: Bun.version,
      platform: process.platform, arch: process.arch, branch: "staging", commit: "test",
      payloadSha256: createHash("sha256").update(bytes).digest("hex"), executableFiles: [], requiredFiles: ["src/index.ts"], ffmpeg: false };
    const roots = await Promise.all([extractServerBundle(archive, manifest, base), extractServerBundle(archive, manifest, base)]);
    expect(roots[0]).toBe(roots[1]);
    expect(readFileSync(join(roots[0]!, "app/src/index.ts"), "utf8")).toContain("fixture");
    expect(await extractServerBundle("missing archive", manifest, base)).toBe(roots[0]);
    await expect(extractServerBundle(archive, { ...manifest, payloadSha256: "0".repeat(64) }, base)).rejects.toThrow("integrity");
    expect(existsSync(join(base, "server", "0".repeat(64)))).toBe(false);
  });
});

describe("bundled first-run setup", () => {
  function setup(base = directory()) {
    const dataDir = join(base, "data");
    const settingsPath = join(base, "server.json");
    const listener = startBundleSetup({ format: 1, dataDir, port: 7860, host: "127.0.0.1" }, settingsPath);
    listeners.push(listener);
    const link = new URL(listener.url);
    const token = link.hash.slice(1);
    const origin = link.origin;
    const body = { username: "owner", password: "bundle-test-password", dataDir, port: 17860, host: "127.0.0.1" };
    const post = (changes: object = {}, headers: Record<string, string> = {}) => fetch(origin + "/api/setup", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Lumiverse-Setup": token, Origin: origin, ...headers }, body: JSON.stringify({ ...body, ...changes }),
    });
    return { listener, dataDir, settingsPath, body, origin, token, post };
  }

  test("the browser form loads defaults, rejects mismatched passwords, and configures the server", async () => {
    const app = setup();
    let posted = 0;
    const page = new JSDOM(BUNDLE_SETUP_PAGE, { url: app.listener.url });
    // Bun's vm does not support jsdom's Proxy global. Execute the actual page
    // script with its DOM/browser APIs directly instead of jsdom's script runner.
    const browserFetch = (input: string, init?: RequestInit) => {
      if (init?.method === "POST") posted++;
      return fetch(new URL(input, app.origin), init);
    };
    new Function("window", "document", "location", "history", "sessionStorage", "fetch", "setTimeout",
      page.window.document.querySelector("script")!.textContent!)(page.window, page.window.document,
      page.window.location, page.window.history, page.window.sessionStorage, browserFetch, page.window.setTimeout.bind(page.window));
    const field = (name: string) => page.window.document.getElementById(name) as HTMLInputElement;
    const button = page.window.document.getElementById("submit") as HTMLButtonElement;
    const submit = () => page.window.document.getElementById("setup")!.dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    const waitFor = async (check: () => boolean) => {
      for (let i = 0; i < 100; i++) { if (check()) return; await Bun.sleep(10); }
      throw new Error("Setup form did not finish updating");
    };
    try {
      await waitFor(() => !button.disabled);
      expect(field("dataDir").value).toBe(app.dataDir);
      expect(field("port").value).toBe("7860");
      expect(page.window.location.hash).toBe("");
      expect(page.window.sessionStorage.getItem("lumiverse.setup")).toBe(app.token);
      field("username").value = app.body.username;
      field("password").value = app.body.password;
      field("confirm").value = "different";
      submit();
      expect(page.window.document.getElementById("message")!.textContent).toContain("do not match");
      expect(posted).toBe(0);
      field("confirm").value = app.body.password;
      submit();
      expect(page.window.document.getElementById("title")!.textContent).toContain("server settings");
      expect(posted).toBe(0);
      field("port").value = "17860";
      submit();
      expect(page.window.document.getElementById("review-port")!.textContent).toBe("17860");
      page.window.document.getElementById("back")!.click();
      expect(field("port").value).toBe("17860");
      page.window.document.getElementById("back")!.click();
      expect(field("password").value).toBe(app.body.password);
      field("username").value = "changed_owner";
      submit();
      submit();
      expect(page.window.document.getElementById("review-username")!.textContent).toBe("changed_owner");
      expect(page.window.document.querySelector(".brand")!.textContent).toBe("Lumiverse · First launch");
      expect(page.window.document.querySelector("small")!.textContent).toContain("3–32");
      submit();
      await waitFor(() => page.window.document.getElementById("message")!.textContent!.includes("Starting Lumiverse"));
      expect(posted).toBe(1);
      expect((await app.listener.settings).dataDir).toBe(app.dataDir);
      expect(field("password").value).toBe("");
      expect(button.disabled).toBe(true);
    } finally { page.window.close(); }
  });

  test("requires a local origin and launch token, then stores only a password hash", async () => {
    const app = setup();
    expect((await app.post({}, { "X-Lumiverse-Setup": "wrong" })).status).toBe(403);
    expect((await app.post({}, { Origin: "https://example.com" })).status).toBe(403);
    expect((await app.post({ password: "short" })).status).toBe(400);
    expect(existsSync(join(app.dataDir, "owner.credentials"))).toBe(false);
    expect((await app.post()).status).toBe(200);
    expect((await app.listener.settings).port).toBe(17860);
    const credentials = JSON.parse(readFileSync(join(app.dataDir, "owner.credentials"), "utf8"));
    expect(await verifyPassword({ hash: credentials.passwordHash, password: app.body.password })).toBe(true);
    expect(readFileSync(app.settingsPath, "utf8")).not.toContain(app.body.password);
    expect((await app.post()).status).toBe(409);
    expect(hasConfiguredOwner(app.dataDir)).toBe(true);
  });

  test("does not overwrite an existing owner or remove another setup's lock", async () => {
    const app = setup();
    mkdirSync(app.dataDir);
    const lock = join(app.dataDir, ".bundle-setup.lock");
    writeFileSync(lock, "another process");
    expect((await app.post()).status).toBe(400);
    expect(readFileSync(lock, "utf8")).toBe("another process");
    rmSync(lock);
    writeFileSync(join(app.dataDir, "owner.credentials"), "existing");
    expect((await app.post()).status).toBe(400);
    expect(readFileSync(join(app.dataDir, "owner.credentials"), "utf8")).toBe("existing");
  });

  test("does not leave credentials behind when settings cannot be saved", async () => {
    const app = setup();
    mkdirSync(app.settingsPath);
    expect((await app.post()).status).toBe(400);
    expect(hasConfiguredOwner(app.dataDir)).toBe(false);
    expect(existsSync(join(app.dataDir, ".bundle-setup.lock"))).toBe(false);
  });
});
