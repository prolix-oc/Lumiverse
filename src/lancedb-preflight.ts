import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { env } from "./env";

function isTermuxLikeEnvironment(): boolean {
  return Boolean(process.env.TERMUX_VERSION)
    || process.env.LUMIVERSE_IS_TERMUX === "true"
    || process.env.LUMIVERSE_IS_PROOT === "true"
    || process.env.PREFIX?.startsWith("/data/data/com.termux/") === true
    || process.env.HOME?.startsWith("/data/data/com.termux/files/home") === true
    || env.dataDir.startsWith("/data/data/com.termux/");
}

export async function configureLanceDbNativeOverride(): Promise<void> {
  const explicitOverride = process.env.LUMIVERSE_LANCEDB_NATIVE_PATH?.trim();
  const workspaceRoot = resolve(import.meta.dir, "..");
  const outDir = join(workspaceRoot, "vendor", "lancedb-android", "out");
  const bundledAndroidOverride = join(outDir, "lancedb.termux-arm64.node");

  if (explicitOverride && existsSync(resolve(explicitOverride))) {
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = resolve(explicitOverride);
    console.log(`[startup] LanceDB native override: ${process.env.NAPI_RS_NATIVE_LIBRARY_PATH}`);
    return;
  }

  if (!isTermuxLikeEnvironment()) return;

  if (!existsSync(bundledAndroidOverride)) {
    console.log("[startup] Android/Termux detected. Missing native LanceDB engine.");
    console.log("[startup] Downloading lancedb.termux-arm64.node... This may take a minute.");
    try {
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      // Fetch the precompiled (and stripped) binary from the rolling release
      const response = await fetch("https://github.com/prolix-oc/Lumiverse/releases/download/android-binaries/lancedb.termux-arm64.node");
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      
      const buffer = await response.arrayBuffer();
      await Bun.write(bundledAndroidOverride, buffer);
      console.log("[startup] Download complete!");
    } catch (err) {
      console.error("[startup] Failed to download native LanceDB engine. Features relying on LanceDB will crash.");
      console.error(err);
      return;
    }
  }

  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = bundledAndroidOverride;
  console.log(`[startup] LanceDB native override: ${bundledAndroidOverride}`);
}
