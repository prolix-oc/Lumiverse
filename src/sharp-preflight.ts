import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const ANDROID_SHARP_BUNDLE = {
  version: "0.35.5",
  id: "0.35.5-r1",
  libvips: "8.18.7-2",
  url: "https://github.com/prolix-oc/Lumiverse/releases/download/android-sharp-v0.35.5-r1/lumiverse-sharp-android-arm64.tar.gz",
  sha256: "d7beee5c7e5cf4248be620963de6bdf2c1193923509bd89ba1c10e41207a01cd",
  manifestSha256: "0eea8a45a7ecebddfb6f7b80706f090838d3adcb445088a5551716ee339ce807",
};

type Bundle = typeof ANDROID_SHARP_BUNDLE;
type FetchBundle = (url: string, init?: RequestInit) => Promise<Response>;
type Manifest = { format: number; version: string; libvips: string; api: number; files: Record<string, string> };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function readManifest(bytes: Uint8Array, bundle: Bundle): Manifest {
  if (sha256(bytes) !== bundle.manifestSha256) throw new Error("Android Sharp manifest checksum mismatch");
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
  if (manifest.format !== 1 || manifest.version !== bundle.version || manifest.libvips !== bundle.libvips || manifest.api !== 29
    || !manifest.files || !manifest.files["lib/libsharp.so"] || !manifest.files["lib/libvips_42.so"]) {
    throw new Error("Android Sharp bundle does not match the required native engine");
  }
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")
      || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid Android Sharp manifest entry");
  }
  return manifest;
}

function validInstallation(directory: string, bundle: Bundle): boolean {
  try {
    const manifest = readManifest(readFileSync(join(directory, "manifest.json")), bundle);
    return Object.entries(manifest.files).every(([name, hash]) => {
      const path = join(directory, name);
      return lstatSync(path).isFile() && sha256(readFileSync(path)) === hash;
    });
  } catch { return false; }
}

export async function installAndroidSharp(
  workspaceRoot: string,
  bundle: Bundle = ANDROID_SHARP_BUNDLE,
  fetchBundle: FetchBundle = fetch,
): Promise<string> {
  const parent = join(workspaceRoot, "vendor", "sharp-android");
  const directory = join(parent, bundle.id);
  if (validInstallation(directory, bundle)) return directory;
  console.log(`[startup] Installing Android Sharp ${bundle.version} and libvips ${bundle.libvips}...`);
  const response = await fetchBundle(bundle.url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Android Sharp download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== bundle.sha256) throw new Error("Android Sharp archive checksum mismatch");
  // Read regular files only, then write the pinned manifest's entries ourselves.
  // Archive symlinks and paths outside the bundle never reach the filesystem.
  const files = await new Bun.Archive(bytes).files();
  const manifestFile = files.get("manifest.json");
  if (!manifestFile) throw new Error("Android Sharp archive is missing its manifest");
  const manifestBytes = new Uint8Array(await manifestFile.arrayBuffer());
  const manifest = readManifest(manifestBytes, bundle);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, ".install-"));
  try {
    for (const [name, hash] of Object.entries(manifest.files)) {
      const file = files.get(name);
      if (!file) throw new Error(`Android Sharp archive is missing ${name}`);
      const content = new Uint8Array(await file.arrayBuffer());
      if (sha256(content) !== hash) throw new Error(`Android Sharp library checksum mismatch: ${name}`);
      await Bun.write(join(temporary, name), content);
    }
    writeFileSync(join(temporary, "manifest.json"), manifestBytes);
    // Keep the last working installation until every replacement file is verified.
    const previous = join(temporary, "previous");
    let movedPrevious = false;
    try {
      try { renameSync(directory, previous); movedPrevious = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      renameSync(temporary, directory);
    } catch (error) {
      if (movedPrevious) renameSync(previous, directory);
      throw error;
    }
    rmSync(join(directory, "previous"), { recursive: true, force: true });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return directory;
}

export async function configureSharpNativeOverride(options: {
  workspaceRoot?: string;
  platform?: string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  bundle?: Bundle;
  fetchBundle?: FetchBundle;
} = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  // Glibc/proot runtimes use the official Linux binding.
  if (platform !== "android" || arch !== "arm64") return;
  const root = options.workspaceRoot ?? resolve(import.meta.dir, "..");
  const bundle = options.bundle ?? ANDROID_SHARP_BUNDLE;
  const sharpPackage = join(root, "node_modules", "sharp", "package.json");
  const installedVersion = JSON.parse(readFileSync(sharpPackage, "utf8")).version;
  if (installedVersion !== bundle.version) {
    throw new Error(`Android Sharp requires sharp ${bundle.version}; installed ${installedVersion}. Update the native engine pin with the package.`);
  }
  let binding: string;
  if (env.LUMIVERSE_NATIVE_DIR) {
    if (!isAbsolute(env.LUMIVERSE_NATIVE_DIR)) throw new Error("The APK native library directory must be absolute");
    // The APK host sets VIPSHOME and installs codecs before launching Bun.
    binding = join(env.LUMIVERSE_NATIVE_DIR, "libsharp.so");
  } else {
    const directory = await installAndroidSharp(root, bundle, options.fetchBundle);
    const modules = join(directory, "vips", "lib", "vips-modules-8.18");
    mkdirSync(modules, { recursive: true });
    for (const codec of ["heif", "jxl"]) {
      const link = join(modules, `vips-${codec}.so`);
      rmSync(link, { force: true });
      symlinkSync(join(directory, "lib", `libvips-${codec}.so`), link);
    }
    env.VIPSHOME = join(directory, "vips");
    // Android Bun 1.4.4's process.env updates do not reach native getenv().
    // libvips needs its plugin home in libc before the addon initializes.
    if (process.platform === "android") {
      const { dlopen } = await import("bun:ffi");
      const libc = dlopen("libc.so", { setenv: { args: ["ptr", "ptr", "i32"], returns: "i32" } });
      try {
        if (libc.symbols.setenv(Buffer.from("VIPSHOME\0"), Buffer.from(env.VIPSHOME + "\0"), 1) !== 0)
          throw new Error("Could not configure Android libvips codec discovery");
      } finally { libc.close(); }
    }
    binding = join(directory, "lib", "libsharp.so");
  }
  // Bun follows symlinks before selecting its loader, so pointing a .node link
  // directly at libsharp.so parses the ELF as JavaScript. Use an explicit
  // process.dlopen wrapper, as the APK does for its other native bindings.
  const wrapper = join(root, "node_modules", "@img", "sharp-android-arm64");
  mkdirSync(wrapper, { recursive: true });
  const entry = join(wrapper, "index.cjs");
  writeFileSync(entry, `process.dlopen(module, ${JSON.stringify(binding)});\n`);
  // Sharp 0.35 uses a fixed platform switch with no Android case. Its local
  // build lookup runs first and reaches the same verified native binding.
  const localBuild = join(root, "node_modules", "sharp", "src", "build", "Release");
  mkdirSync(localBuild, { recursive: true });
  const link = join(localBuild, `sharp-android-arm64-${bundle.version}.node`);
  rmSync(link, { force: true });
  symlinkSync(entry, link);
}
