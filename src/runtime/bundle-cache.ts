import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerBundleManifest } from "./bundle";

function complete(root: string, manifest: ServerBundleManifest): boolean {
  try {
    return readFileSync(join(root, ".complete"), "utf8") === manifest.payloadSha256
      && [...manifest.requiredFiles.map((path) => join(root, "app", path)),
        join(root, "bin", process.platform === "win32" ? "bun.exe" : "bun"),
        join(root, "compat", process.platform === "win32" ? "node.exe" : "node")]
        .every((path) => { const stat = statSync(path); return stat.isFile() && stat.size > 0; });
  } catch { return false; }
}

/** Publish an entire runtime atomically. Concurrent launches never see a partial extraction. */
export async function extractServerBundle(
  archivePath: string,
  manifest: ServerBundleManifest,
  cacheDir: string,
): Promise<string> {
  const parent = join(cacheDir, "server");
  const root = join(parent, manifest.payloadSha256);
  if (complete(root, manifest)) return root;
  if (existsSync(root)) throw new Error(`The cached runtime is incomplete: ${root}. Remove this cache directory and launch again; your data is stored separately.`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.extract-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    const bytes = await Bun.file(archivePath).bytes();
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.payloadSha256) throw new Error("Embedded server archive failed its integrity check.");
    await new Bun.Archive(bytes).extract(join(temporary, "app"));
    for (const path of manifest.executableFiles) chmodSync(join(temporary, "app", path), 0o755);
    const bin = join(temporary, "bin");
    mkdirSync(bin);
    const bun = join(bin, process.platform === "win32" ? "bun.exe" : "bun");
    // Use a plain runtime so third-party standalone Bun executables do not
    // inherit BUN_BE_BUN and accidentally execute as the Bun CLI themselves.
    const runtime = join(temporary, "app", "runtime", process.platform === "win32" ? "bun.exe" : "bun");
    try { linkSync(runtime, bun); } catch { copyFileSync(runtime, bun); }
    chmodSync(bun, 0o755);
    mkdirSync(join(temporary, "compat"));
    const node = join(temporary, "compat", process.platform === "win32" ? "node.exe" : "node");
    try { linkSync(bun, node); } catch { copyFileSync(bun, node); }
    writeFileSync(join(temporary, ".complete"), manifest.payloadSha256);
    if (!complete(temporary, manifest)) throw new Error("Embedded server archive is missing required files.");
    try { renameSync(temporary, root); }
    catch (error) { if (!complete(root, manifest)) throw error; }
    return root;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
