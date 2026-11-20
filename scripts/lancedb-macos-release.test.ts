import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseAPI, type GitHubAsset, type GitHubRelease, type ReleaseAsset } from "./desktop-release";
import { INTEL_LANCEDB, intelLanceDbBuildId, readIntelLanceDbArtifact } from "./lancedb-macos-native";
import { downloadIntelLanceDb, intelLanceDbReleaseTag, publishIntelLanceDb } from "./lancedb-macos-release";

const temporary: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "lumiverse-native-release-test-")); temporary.push(path); return path; }
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function artifact() {
  const path = directory(), binary = Buffer.alloc(56);
  for (const [offset, value] of [[0, 0xfeedfacf], [4, 0x01000007], [8, 3], [12, 6], [16, 1], [20, 24], [32, 0x32], [36, 24], [40, 1], [44, 13 << 16]]) binary.writeUInt32LE(value!, offset);
  const { buildRevision, binaryName, ...policy } = INTEL_LANCEDB;
  writeFileSync(join(path, binaryName), binary);
  writeFileSync(join(path, "manifest.json"), JSON.stringify({ ...policy, format: 1, buildId: intelLanceDbBuildId(), sha256: createHash("sha256").update(binary).digest("hex") }));
  writeFileSync(join(path, "LICENSE"), "license fixture");
  return path;
}

class NativeAPI extends ReleaseAPI {
  current: GitHubRelease | null = null;
  stored = new Map<string, { asset: GitHubAsset; bytes: Uint8Array }>();
  mutations: string[] = [];
  failUpload = false;
  failDownload = false;
  creation: Record<string, unknown> | undefined;
  constructor() { super("test/Lumiverse", "test-token"); }
  override async release() { return this.current; }
  override async assets() { return [...this.stored.values()].map(value => value.asset); }
  override async assetBytes(asset: GitHubAsset) {
    if (this.failDownload) throw new Error("Download unavailable (503)");
    return [...this.stored.values()].find(value => value.asset.id === asset.id)!.bytes;
  }
  override async upload(release: GitHubRelease, asset: ReleaseAsset) {
    expect(release.draft).toBe(true);
    this.mutations.push(`upload ${asset.name}`);
    if (this.failUpload) throw new Error("Upload unavailable");
    this.stored.set(asset.name, { asset: { id: this.stored.size + 1, name: asset.name, browser_download_url: "unused" }, bytes: readFileSync(asset.path!) });
  }
  override async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    this.mutations.push(`${init.method} ${path}`);
    const value = JSON.parse(String(init.body));
    expect(value.make_latest).toBe("false");
    expect(value.prerelease).toBe(true);
    if (path === "/releases") {
      this.creation = value;
      this.current = { ...value, id: 1, upload_url: "unused" } as GitHubRelease;
    } else this.current = { ...this.current!, ...value };
    return this.current as T;
  }
}
const source = "a".repeat(40);

test("a verified dependency publishes once, downloads, and reruns without any writes", async () => {
  const api = new NativeAPI(), local = artifact(), downloaded = directory();
  await publishIntelLanceDb(api, local, source, "Test provenance");
  expect(api.current?.draft).toBe(false);
  expect(api.creation?.tag_name).toBe(intelLanceDbReleaseTag());
  expect(api.creation?.target_commitish).toBe(source);
  expect(await downloadIntelLanceDb(api, downloaded)).toBe(true);
  expect(readIntelLanceDbArtifact(downloaded, INTEL_LANCEDB.version)).toEqual(readIntelLanceDbArtifact(local, INTEL_LANCEDB.version));
  expect(readFileSync(join(downloaded, "LICENSE"), "utf8")).toBe("license fixture");
  const previous = [...api.mutations];
  await publishIntelLanceDb(api, local, source, "Rerun");
  expect(api.mutations).toEqual(previous);
});

test("missing dependencies fail normal desktop builds and only the dependency workflow may continue", async () => {
  const api = new NativeAPI(), output = directory();
  await expect(downloadIntelLanceDb(api, output)).rejects.toThrow("intel-lancedb.yml");
  expect(await downloadIntelLanceDb(api, output, true)).toBe(false);
  expect(api.mutations).toEqual([]);
});

test("an interrupted upload remains a draft and the dependency workflow can resume it", async () => {
  const api = new NativeAPI(), local = artifact();
  api.failUpload = true;
  await expect(publishIntelLanceDb(api, local, source, "First attempt")).rejects.toThrow("Upload unavailable");
  expect(api.current?.draft).toBe(true);
  expect(await downloadIntelLanceDb(api, directory(), true)).toBe(false);
  api.failUpload = false;
  await publishIntelLanceDb(api, local, source, "Retry");
  expect(api.current?.draft).toBe(false);
  expect(api.mutations.filter(value => value === "POST /releases")).toHaveLength(1);
});

test("failed upload verification never publishes the draft", async () => {
  const api = new NativeAPI();
  api.failDownload = true;
  await expect(publishIntelLanceDb(api, artifact(), source, "Fixture")).rejects.toThrow("503");
  expect(api.current?.draft).toBe(true);
  expect(api.mutations.some(value => value.startsWith("PATCH"))).toBe(false);
});

test("missing and corrupted release assets never install a partial native artifact", async () => {
  const api = new NativeAPI(), local = artifact(), output = directory();
  await publishIntelLanceDb(api, local, source, "Fixture");
  const license = api.stored.get("LICENSE")!;
  api.stored.delete("LICENSE");
  await expect(downloadIntelLanceDb(api, output)).rejects.toThrow("missing LICENSE");
  expect(existsSync(join(output, INTEL_LANCEDB.binaryName))).toBe(false);
  api.stored.set("LICENSE", license);
  api.stored.get(INTEL_LANCEDB.binaryName)!.bytes = Buffer.from("corrupted");
  await expect(downloadIntelLanceDb(api, output)).rejects.toThrow("checksum");
  expect(existsSync(join(output, "manifest.json"))).toBe(false);
});

test("an outage cannot silently turn a published dependency into a rebuild", async () => {
  const api = new NativeAPI(), local = artifact();
  await publishIntelLanceDb(api, local, source, "Fixture");
  api.failDownload = true;
  await expect(downloadIntelLanceDb(api, directory(), true)).rejects.toThrow("503");
});

test("a published dependency cannot be replaced by a different valid binary", async () => {
  const api = new NativeAPI(), local = artifact();
  await publishIntelLanceDb(api, local, source, "Fixture");
  const binary = Buffer.concat([readFileSync(join(local, INTEL_LANCEDB.binaryName)), Buffer.from("new bytes")]);
  writeFileSync(join(local, INTEL_LANCEDB.binaryName), binary);
  const value = JSON.parse(readFileSync(join(local, "manifest.json"), "utf8"));
  writeFileSync(join(local, "manifest.json"), JSON.stringify({ ...value, sha256: createHash("sha256").update(binary).digest("hex") }));
  expect(readIntelLanceDbArtifact(local, INTEL_LANCEDB.version).sha256).not.toBe(value.sha256);
  const previous = [...api.mutations];
  await expect(publishIntelLanceDb(api, local, source, "Changed")).rejects.toThrow("Refusing to replace");
  expect(api.mutations).toEqual(previous);
});

test("release asset download requests binary bytes instead of parsing JSON", async () => {
  const api = new ReleaseAPI("test/Lumiverse", "test-token", (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.github.com/repos/test/Lumiverse/releases/assets/42");
    expect(new Headers(init?.headers).get("Accept")).toBe("application/octet-stream");
    return new Response(new Uint8Array([0, 255, 128]));
  }) as typeof fetch);
  expect(await api.assetBytes({ id: 42, name: "native.node", browser_download_url: "unused" })).toEqual(new Uint8Array([0, 255, 128]));
});
