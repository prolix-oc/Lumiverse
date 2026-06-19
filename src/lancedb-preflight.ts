import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { env } from "./env";

const NATIVE_BINARY_VERSION = "0.29.0";

function isTermuxLikeEnvironment(): boolean {
  return Boolean(process.env.TERMUX_VERSION)
    || process.env.LUMIVERSE_IS_TERMUX === "true"
    || process.env.LUMIVERSE_IS_PROOT === "true"
    || process.env.PREFIX?.startsWith("/data/data/com.termux/") === true
    || process.env.HOME?.startsWith("/data/data/com.termux/files/home") === true
    || env.dataDir.startsWith("/data/data/com.termux/");
}

function needsDownload(binaryPath: string, stampPath: string): boolean {
  if (!existsSync(binaryPath)) return true;
  try {
    return readFileSync(stampPath, "utf-8").trim() !== NATIVE_BINARY_VERSION;
  } catch {
    return true;
  }
}

export async function configureLanceDbNativeOverride(): Promise<void> {
  const explicitOverride = process.env.LUMIVERSE_LANCEDB_NATIVE_PATH?.trim();
  const workspaceRoot = resolve(import.meta.dir, "..");
  const outDir = join(workspaceRoot, "vendor", "lancedb-android", "out");
  const bundledAndroidOverride = join(outDir, "lancedb.termux-arm64.node");
  const versionStamp = join(outDir, ".lancedb-native-version");

  if (explicitOverride && existsSync(resolve(explicitOverride))) {
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = resolve(explicitOverride);
    console.log(`[startup] LanceDB native override: ${process.env.NAPI_RS_NATIVE_LIBRARY_PATH}`);
    return;
  }

  if (!isTermuxLikeEnvironment()) return;

  if (needsDownload(bundledAndroidOverride, versionStamp)) {
    if (existsSync(bundledAndroidOverride)) {
      console.log("[startup] LanceDB native engine is outdated — upgrading to v" + NATIVE_BINARY_VERSION);
      try { unlinkSync(bundledAndroidOverride); } catch {}
    }
    console.log("[startup] Android/Termux detected. Missing native LanceDB engine.");
    console.log("[startup] Downloading lancedb.termux-arm64.node... This may take a minute.");
    try {
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      // Fetch the precompiled (and stripped) binary from the rolling release
      const response = await fetch("https://github.com/prolix-oc/Lumiverse/releases/download/android-binaries/lancedb.termux-arm64.node");
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      const totalBytes = Number(response.headers.get("content-length") || 0);
      const totalMB = totalBytes ? (totalBytes / 1_048_576).toFixed(1) : "?";
      let receivedBytes = 0;
      let lastLoggedPct = -10;
      const chunks: Uint8Array[] = [];

      for await (const chunk of response.body as ReadableStream<Uint8Array>) {
        chunks.push(chunk);
        receivedBytes += chunk.byteLength;
        if (totalBytes) {
          const pct = Math.floor((receivedBytes / totalBytes) * 100);
          if (pct - lastLoggedPct >= 10) {
            lastLoggedPct = pct;
            const receivedMB = (receivedBytes / 1_048_576).toFixed(1);
            console.log(`[startup] Downloading LanceDB engine... ${receivedMB}/${totalMB} MB (${pct}%)`);
          }
        }
      }

      const merged = new Uint8Array(receivedBytes);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }

      await Bun.write(bundledAndroidOverride, merged);
      writeFileSync(versionStamp, NATIVE_BINARY_VERSION);
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
