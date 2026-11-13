import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { join, relative, basename, resolve, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";

const policy = JSON.parse(readFileSync(new URL("../desktop/linux-runtime-policy.json", import.meta.url), "utf8")) as { hostLibraries: Record<string,string>; buildBaseline: string };
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
function version(command: string[]) {
  try { const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 5000 }); return result.exitCode === 0 ? result.stdout.toString().trim() : "unavailable"; }
  catch { return "unavailable"; }
}
export function verifyPolicy(appdir: string) {
  const files = walk(appdir);
  const forbidden = files.filter(file => Object.keys(policy.hostLibraries).some(name => basename(file) === name || basename(file).startsWith(`${name}.`) || (name.endsWith("-") && basename(file).startsWith(name))));
  if (forbidden.length) throw new Error(`AppImage bundles host graphics libraries: ${forbidden.map(file => relative(appdir, file)).join(", ")}`);
  return files.sort();
}
export function runtimeManifest(appdir: string, verify = false, collectMetadata = collectBuildMetadata) {
  appdir = realpathSync(resolve(appdir));
  const files = verifyPolicy(appdir);
  const runtimeFiles = files.filter(file => /(?:lib(?:webkit|javascriptcore|gtk|gdk|glib|gobject|gio|soup|gst|wayland)|WebKit(?:Web|Network|GPU)Process|gst-plugin-scanner)/i.test(basename(file)));
  for (const file of runtimeFiles) {
    const target = relative(appdir, realpathSync(file));
    if (target === ".." || target.startsWith(".." + sep) || isAbsolute(target)) throw new Error(`Native runtime symlink escapes the AppImage: ${relative(appdir, file)}`);
  }
  for (const required of ["WebKitWebProcess", "WebKitNetworkProcess"]) {
    if (!runtimeFiles.some(file => basename(file) === required)) throw new Error(`AppImage is missing its matching ${required} helper`);
  }
  const entries = Object.fromEntries(runtimeFiles.map(file => [relative(appdir, file), digest(file)]));
  const path = join(appdir, "usr/share/lumiverse/runtime-manifest.json");
  if (verify) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (JSON.stringify(manifest.files) !== JSON.stringify(entries)) throw new Error("Packaged native runtime differs from its manifest");
    return manifest;
  }
  const manifest = {
    format: 1, ...collectMetadata(), buildBaseline: policy.buildBaseline, policy, files: entries,
  };
  mkdirSync(join(appdir, "usr/share/lumiverse"), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
  return manifest;
}

function collectBuildMetadata() {
  const packages = ["gtk+-3.0", "webkit2gtk-4.1", "javascriptcoregtk-4.1", "glib-2.0", "gio-2.0", "libsoup-3.0", "gstreamer-1.0", "wayland-client"];
  const lock = Bun.TOML.parse(readFileSync(new URL("../desktop/src-tauri/Cargo.lock", import.meta.url), "utf8")) as { package: Array<{name: string; version: string}> };
  const crates = Object.fromEntries(lock.package.filter(p => ["tauri", "wry", "tao", "tauri-bundler", "tauri-plugin-opener"].includes(p.name)).map(p => [p.name, p.version]));
  const cache = join(process.env.XDG_CACHE_HOME || join(process.env.HOME || "/tmp", ".cache"), "tauri");
  const tools: Record<string,string> = {};
  try { for (const name of readdirSync(cache).filter(n => n.startsWith("linuxdeploy") || n.startsWith("AppRun"))) { const file = join(cache, name); if (statSync(file).isFile()) tools[name] = digest(file); } } catch { /* No tool cache in source tests. */ }
  // These probes describe the Linux runtime; other platforms do not need them.
  const linuxVersion = (command: string[]) => process.platform === "linux" ? version(command) : "unavailable";
  return {
    revision: version(["git", "rev-parse", "HEAD"]), architecture: process.arch,
    buildOS: (() => { try { return readFileSync("/etc/os-release", "utf8"); } catch { return process.platform; } })(),
    glibc: linuxVersion(["getconf", "GNU_LIBC_VERSION"]), nativeVersions: Object.fromEntries(packages.map(pkg => [pkg, linuxVersion(["pkg-config", "--modversion", pkg])])),
    debianPackages: process.platform === "linux" ? version(["dpkg-query", "-W", "-f=${Package}=${Version}\n", "libwebkit2gtk-4.1-0", "libjavascriptcoregtk-4.1-0", "libgtk-3-0", "libglib2.0-0", "libsoup-3.0-0"]) : "unavailable",
    crates, tauriCli: (() => { try { return JSON.parse(readFileSync(new URL("../desktop/node_modules/@tauri-apps/cli/package.json", import.meta.url), "utf8")).version; } catch { return "unavailable"; } })(),
    packagingToolSha256: tools,
  };
}
if (import.meta.main) {
  try { runtimeManifest(process.argv[2]!, process.argv.includes("--verify")); console.log("Verified AppImage graphics library policy and native runtime manifest."); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
}
