#!/usr/bin/env bun
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ReleaseAPI, type GitHubRelease } from "./desktop-release";
import { INTEL_LANCEDB, intelLanceDbBuildId, readIntelLanceDbArtifact } from "./lancedb-macos-native";

export const intelLanceDbReleaseTag = () => `native-lancedb-v${INTEL_LANCEDB.version}-darwin-x64-${intelLanceDbBuildId().slice(0, 16)}`;
const files = [INTEL_LANCEDB.binaryName, "manifest.json", "LICENSE"] as const;
const marker = () => `<!-- lumiverse-intel-lancedb:${intelLanceDbBuildId()} -->`;

async function receiveArtifact(api: ReleaseAPI, release: GitHubRelease, directory: string) {
  const assets = await api.assets(release.id);
  // Validate in isolation before installing any downloaded bytes into the build.
  const temporary = mkdtempSync(join(tmpdir(), "lumiverse-lancedb-download-"));
  try {
    for (const name of files) {
      const asset = assets.find(asset => asset.name === name);
      if (!asset) throw new Error(`Intel LanceDB release is missing ${name}.`);
      writeFileSync(join(temporary, name), await api.assetBytes(asset));
    }
    const manifest = readIntelLanceDbArtifact(temporary, INTEL_LANCEDB.version);
    mkdirSync(directory, { recursive: true });
    for (const name of files) copyFileSync(join(temporary, name), join(directory, name));
    return manifest;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export async function downloadIntelLanceDb(api: ReleaseAPI, directory: string, allowMissing = false): Promise<boolean> {
  const release = await api.release(intelLanceDbReleaseTag());
  if (!release || release.draft) {
    if (allowMissing) return false;
    throw new Error(`Publish ${intelLanceDbReleaseTag()} with the Intel LanceDB dependency workflow (intel-lancedb.yml). Desktop builds never compile LanceDB.`);
  }
  await receiveArtifact(api, release, directory);
  console.log(`Downloaded and checksum-verified ${release.tag_name}.`);
  return true;
}

/** Publish once; reruns verify an existing release without replacing its bytes. */
export async function publishIntelLanceDb(api: ReleaseAPI, directory: string, source: string, provenance: string): Promise<void> {
  const local = readIntelLanceDbArtifact(directory, INTEL_LANCEDB.version);
  for (const name of files) readFileSync(join(directory, name));
  let release = await api.release(intelLanceDbReleaseTag());
  if (release && !release.draft) {
    const temporary = mkdtempSync(join(tmpdir(), "lumiverse-lancedb-existing-"));
    try {
      const existing = await receiveArtifact(api, release, temporary);
      if (existing.sha256 !== local.sha256) throw new Error("Refusing to replace a published Intel LanceDB binary. Change its build policy first.");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    console.log(`Keeping existing ${release.tag_name}.`);
    return;
  }
  if (release && !release.body.includes(marker())) throw new Error("The Intel LanceDB draft belongs to a different build policy.");
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("A source commit is required for the native dependency release.");
  if (!release) release = await api.request<GitHubRelease>("/releases", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      tag_name: intelLanceDbReleaseTag(), target_commitish: source,
      name: `Intel macOS LanceDB ${INTEL_LANCEDB.version} (${intelLanceDbBuildId().slice(0, 16)})`,
      draft: true, prerelease: true, make_latest: "false",
      body: `${marker()}\n\nReusable Node/Bun addon for Intel macOS ${INTEL_LANCEDB.minimumMacOS} and newer.\n\n`
        + `LanceDB source: https://github.com/lancedb/lancedb/commit/${INTEL_LANCEDB.sourceCommit}\n`
        + `Rust: ${INTEL_LANCEDB.rustToolchain}; CPU: ${INTEL_LANCEDB.cpu}; build policy: ${intelLanceDbBuildId()}.\n\n`
        + `Binary SHA-256: ${local.sha256}\n\nNative database checks passed before publication. ${provenance}`,
    }),
  });
  for (const name of files) await api.upload(release, { name, path: join(directory, name), contentType: name.endsWith(".json") ? "application/json" : "application/octet-stream" });
  const temporary = mkdtempSync(join(tmpdir(), "lumiverse-lancedb-upload-"));
  try {
    const uploaded = await receiveArtifact(api, release, temporary);
    if (uploaded.sha256 !== local.sha256) throw new Error("Uploaded Intel LanceDB binary differs from the tested artifact.");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  await api.request(`/releases/${release.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft: false, prerelease: true, make_latest: "false" }) });
  console.log(`Published ${release.tag_name}.`);
}

if (import.meta.main) {
  const mode = process.argv[2];
  const output = (values: Record<string, string>) => {
    for (const [key, value] of Object.entries(values)) {
      console.log(`${key}=${value}`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  };
  const root = resolve(import.meta.dir, "..");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@lancedb/lancedb"];
  if (version !== INTEL_LANCEDB.version) throw new Error("Update the Intel LanceDB source pin to match package.json.");
  if (mode === "identity") output({ tag: intelLanceDbReleaseTag(), cache_key: `intel-lancedb-build-${intelLanceDbBuildId()}`,
    rust_toolchain: INTEL_LANCEDB.rustToolchain, target: INTEL_LANCEDB.target });
  else {
    const api = new ReleaseAPI(process.env.GITHUB_REPOSITORY || "prolix-oc/Lumiverse", process.env.GITHUB_TOKEN!);
    const directory = join(root, "dist/native/lancedb-darwin-x64");
    if (mode === "download" && process.argv.slice(3).every(arg => arg === "--allow-missing")) {
      output({ available: String(await downloadIntelLanceDb(api, directory, process.argv.includes("--allow-missing"))) });
    } else if (mode === "publish") {
      await publishIntelLanceDb(api, directory, process.env.GITHUB_SHA!,
        `Workflow: https://github.com/${api.repository}/actions/runs/${process.env.GITHUB_RUN_ID}`);
    } else throw new Error("Use lancedb-macos-release.ts <identity|download [--allow-missing]|publish>.");
  }
}
