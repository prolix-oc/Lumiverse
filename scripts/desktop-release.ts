import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ReleaseChannel = "stable" | "nightly";
export const UPDATE_PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "linux-aarch64", "windows-x86_64", "windows-aarch64"] as const;
export type UpdatePlatform = typeof UPDATE_PLATFORMS[number];
export interface DesktopFeed {
  version: string;
  channel: ReleaseChannel;
  notes: string;
  pub_date: string;
  commit: string;
  bundle_source: string;
  platforms: Record<string, { url: string; signature: string }>;
}
// Include shipped sources, dependencies, native assets, and packaging policy.
// A docs-only commit outside this set does not rebuild the desktop nightly.
export const BUNDLED_SOURCE_PATHS = ["src", "frontend", "desktop", "user-docs/docs", "package.json", "bun.lock", "tsconfig.json", "LICENSE.md",
  "scripts/build-server.ts", "scripts/build-desktop-server.ts", "scripts/build-lancedb-macos.ts", "scripts/lancedb-macos-native.ts", "scripts/lancedb-macos-release.ts", "scripts/reset-password.ts",
  "scripts/input.ts", "scripts/ui.ts", "scripts/tauri-finalized.ts", "scripts/appimage-patchelf.sh", "scripts/finalize-appimage.sh", "scripts/verify-appimage-permissions.sh", "scripts/verify-appimage-gstreamer.sh",
  "scripts/appimage-apprun.sh", "scripts/appimage-runtime-manifest.ts", "scripts/linux-arm64-cross.ts",
  "scripts/private-linux-release.ts", "scripts/linux-appimage-builder",
  "scripts/desktop-release.ts", "scripts/prepare-desktop-release.ts", "scripts/publish-desktop-release.ts",
  ".github/workflows/server-bundle.yml", ".github/workflows/desktop-release.yml", ".github/workflows/desktop-nightly.yml", ".github/workflows/desktop-linux-complete.yml"];
const UNSHIPPED_PATHS = ["desktop/README.md", "desktop/LINUX-VALIDATION.md", "desktop/releases", "desktop/tests", "frontend/README.md"];
export function sourceFingerprint(cwd: string): string {
  const tree = Bun.spawnSync(["git", "ls-tree", "-rz", "HEAD", "--", ...BUNDLED_SOURCE_PATHS], { cwd, stdout: "pipe", stderr: "pipe" });
  if (tree.exitCode !== 0) throw new Error(new TextDecoder().decode(tree.stderr));
  const shipped = new TextDecoder().decode(tree.stdout).split("\0").filter((entry) => {
    if (!entry) return false;
    const path = entry.slice(entry.indexOf("\t") + 1);
    return !UNSHIPPED_PATHS.some((prefix) => path === prefix || path.startsWith(prefix + "/"))
      && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
      && !path.split("/").some((part) => part === "test-fixtures" || part === "__tests__");
  });
  return createHash("sha256").update(shipped.join("\0")).digest("hex");
}
export function releaseVersion(base: string, channel: ReleaseChannel, date: Date, runNumber: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error("Release the desktop from a stable X.Y.Z base version.");
  if (channel === "stable") return base;
  if (!/^[1-9]\d*$/.test(runNumber)) throw new Error("A nightly needs a positive GitHub run number.");
  const [major, minor, patch] = base.split(".");
  return `${major}.${minor}.${Number(patch) + 1}-nightly.${date.toISOString().slice(0, 10).replaceAll("-", "")}.${runNumber}`;
}
export function validateFeed(value: unknown, channel: ReleaseChannel): DesktopFeed {
  const feed = value as DesktopFeed;
  if (!feed || feed.channel !== channel || typeof feed.version !== "string" || typeof feed.bundle_source !== "string"
    || !/^[a-f0-9]{64}$/.test(feed.bundle_source) || !/^[a-f0-9]{40}$/.test(feed.commit)
    || (channel === "stable" ? !/^\d+\.\d+\.\d+$/.test(feed.version) : !/^\d+\.\d+\.\d+-nightly\.\d+\.\d+$/.test(feed.version))) {
    throw new Error("Invalid desktop channel feed.");
  }
  for (const platform of UPDATE_PLATFORMS) {
    const entry = feed.platforms?.[platform];
    if (!entry || typeof entry.signature !== "string" || !entry.signature.trim() || typeof entry.url !== "string" || !entry.url.startsWith("https://github.com/")) {
      throw new Error(`Incomplete updater feed: ${platform}`);
    }
  }
  return feed;
}
export function mergeFeeds(fragments: DesktopFeed[], channel: ReleaseChannel, version: string, commit: string, fingerprint: string): DesktopFeed {
  const platforms: DesktopFeed["platforms"] = {};
  for (const fragment of fragments) {
    if (fragment.version !== version || fragment.channel !== channel || fragment.commit !== commit || fragment.bundle_source !== fingerprint) throw new Error("Release fragments describe different builds.");
    for (const [target, artifact] of Object.entries(fragment.platforms)) {
      if (platforms[target]) throw new Error(`Duplicate updater platform: ${target}`);
      platforms[target] = artifact;
    }
  }
  return validateFeed({ ...fragments[0], version, channel, commit, bundle_source: fingerprint, platforms }, channel);
}
export interface ReleaseAsset { name: string; path?: string; bytes?: Uint8Array; contentType: string }
export function collectReleaseAssets(bundleRoot: string, platform: UpdatePlatform, version: string): { assets: ReleaseAsset[]; updater: ReleaseAsset; signature: string } {
  const folder = join(bundleRoot, platform.startsWith("linux-") ? "appimage" : platform.startsWith("darwin-") ? "macos" : "nsis");
  const suffix = platform.startsWith("linux-") ? ".AppImage" : platform.startsWith("darwin-") ? ".app.tar.gz" : "-setup.exe";
  const candidates = readdirSync(folder).filter((name) => name.endsWith(suffix) && statSync(join(folder, name)).isFile());
  if (candidates.length !== 1) throw new Error(`Expected one signed updater artifact for ${platform}; found ${candidates.length}`);
  const source = join(folder, candidates[0]!);
  if (!existsSync(source + ".sig")) throw new Error(`Missing updater signature: ${source}`);
  const signature = readFileSync(source + ".sig", "utf8").trim();
  if (!signature) throw new Error("Empty updater signature.");
  const updater: ReleaseAsset = { name: `lumiverse-desktop-${platform}-${version}${suffix}`, path: source, contentType: "application/octet-stream" };
  const assets: ReleaseAsset[] = [updater, { name: updater.name + ".sig", path: source + ".sig", contentType: "text/plain" }];
  if (platform.startsWith("darwin-")) {
    const dmgs = readdirSync(join(bundleRoot, "dmg")).filter((name) => name.endsWith(".dmg"));
    if (dmgs.length !== 1) throw new Error("Expected one macOS installer.");
    assets.push({ name: `lumiverse-desktop-${platform}-${version}.dmg`, path: join(bundleRoot, "dmg", dmgs[0]!), contentType: "application/octet-stream" });
  }
  for (const asset of assets) if (asset.path && statSync(asset.path).size >= 2 * 1024 ** 3) throw new Error(`Release asset exceeds GitHub's 2 GiB limit: ${asset.name}`);
  return { assets, updater, signature };
}

export interface GitHubRelease { id: number; draft: boolean; body: string; upload_url: string; tag_name: string; target_commitish: string }
export interface GitHubAsset { id: number; name: string; browser_download_url: string }
export class ReleaseAPI {
  readonly base: string;
  constructor(readonly repository: string, private token: string, private transport: typeof fetch = fetch) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository.");
    if (!token) throw new Error("GITHUB_TOKEN is required to publish a release.");
    this.base = `https://api.github.com/repos/${repository}`;
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.transport(path.startsWith("https://") ? path : this.base + path, {
      ...init, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...init.headers },
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub release request failed (${response.status}): ${await response.text()}`), { status: response.status });
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  async release(tag: string): Promise<GitHubRelease | null> {
    try { return await this.request(`/releases/tags/${encodeURIComponent(tag)}`); }
    catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    // Draft tags are not created until publication, so GitHub's tag endpoint
    // cannot resolve an unpublished release. Authenticated listings include it.
    for (let page = 1; ; page++) {
      const releases = await this.request<GitHubRelease[]>(`/releases?per_page=100&page=${page}`);
      const draft = releases.find((release) => release.draft && release.tag_name === tag);
      if (draft) return draft;
      if (releases.length < 100) return null;
    }
  }
  async assets(id: number): Promise<GitHubAsset[]> {
    const assets: GitHubAsset[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<GitHubAsset[]>(`/releases/${id}/assets?per_page=100&page=${page}`);
      assets.push(...batch); if (batch.length < 100) return assets;
    }
  }
  async upload(release: GitHubRelease, asset: ReleaseAsset): Promise<void> {
    const existing = (await this.assets(release.id)).find((item) => item.name === asset.name);
    if (existing) await this.request(`/releases/assets/${existing.id}`, { method: "DELETE" });
    const url = release.upload_url.split("{")[0] + `?name=${encodeURIComponent(asset.name)}`;
    const body = asset.bytes ? new Blob([new Uint8Array(asset.bytes)]) : asset.path ? Bun.file(asset.path) : undefined;
    if (!body) throw new Error(`No bytes for asset ${asset.name}`);
    const response = await this.transport(url, { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": asset.contentType }, body });
    if (!response.ok) throw new Error(`Release asset upload failed (${response.status}): ${asset.name}`);
  }
  async assetJSON(asset: GitHubAsset): Promise<DesktopFeed> {
    const response = await this.transport(`${this.base}/releases/assets/${asset.id}`, { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/octet-stream" } });
    if (!response.ok) throw new Error(`Could not read ${asset.name} (${response.status})`);
    return await response.json() as DesktopFeed;
  }
  async assetBytes(asset: GitHubAsset): Promise<Uint8Array> {
    const response = await this.transport(`${this.base}/releases/assets/${asset.id}`, { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/octet-stream" } });
    if (!response.ok) throw new Error(`Could not read ${asset.name} (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
