import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectReleaseAssets, mergeFeeds, ReleaseAPI, UPDATE_PLATFORMS, validateFeed, type DesktopFeed, type GitHubRelease, type ReleaseChannel, type UpdatePlatform } from "./desktop-release";

export interface ReleaseBuild { channel: ReleaseChannel; version: string; tag: string; sha: string; fingerprint: string }
function marker(build: ReleaseBuild): string { return `<!-- lumiverse-bundled:${build.sha}:${build.fingerprint} -->`; }
export async function pruneAbandonedNightlyDrafts(api: ReleaseAPI, build: ReleaseBuild): Promise<void> {
  if (build.channel !== "nightly") return;
  // Collect first: deleting while paginating can shift releases between pages.
  const candidates: GitHubRelease[] = [];
  for (let page = 1; ; page++) {
    const releases = await api.request<GitHubRelease[]>(`/releases?per_page=100&page=${page}`);
    candidates.push(...releases.filter((release) => release.draft));
    if (releases.length < 100) break;
  }
  for (const candidate of candidates) {
    const tag = candidate.tag_name.match(/^desktop-v(\d+\.\d+\.\d+-nightly\.\d{8}\.([1-9]\d*))$/);
    const source = candidate.body?.match(/<!-- lumiverse-bundled:([a-f0-9]{40}):[a-f0-9]{64} -->/);
    if (!tag || !source || Bun.semver.order(tag[1]!, build.version) >= 0) continue;
    try {
      const release = await api.request<GitHubRelease>(`/releases/${candidate.id}`);
      if (!release.draft || release.tag_name !== candidate.tag_name || release.body !== candidate.body || release.target_commitish !== source[1]) continue;
      const run = await api.request<{ status: string; conclusion: string | null; path: string }>(`/actions/runs/${tag[2]}`);
      // Scheduled runs use the default branch's workflow SHA, while the bundled
      // source is staging. Check the owning workflow and the draft's source.
      if (run.status !== "completed" || ![".github/workflows/desktop-nightly.yml", ".github/workflows/desktop-build.yml"].includes(run.path)
        || !["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(run.conclusion ?? "")) continue;
      await api.request(`/releases/${release.id}`, { method: "DELETE" });
      console.log(`Removed superseded incomplete nightly draft: ${release.tag_name}`);
    } catch (error) {
      console.warn(`Could not clean nightly draft ${candidate.tag_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
export async function createDesktopRelease(api: ReleaseAPI, build: ReleaseBuild): Promise<GitHubRelease> {
  const existing = await api.release(build.tag);
  if (existing) {
    if (!existing.draft || !existing.body.includes(marker(build))) throw new Error("Refusing to overwrite a published or different desktop release.");
    return existing;
  }
  return api.request("/releases", { method: "POST", body: JSON.stringify({
    tag_name: build.tag, target_commitish: build.sha, name: `Lumiverse Desktop ${build.version}`,
    draft: true, prerelease: build.channel === "nightly", make_latest: "false",
    body: `Self-contained Lumiverse Desktop (${build.channel}), built from ${build.sha}.\n\nIncludes the server, Bun runtime, frontend, and native libraries. Linux: AppImage only. Windows: NSIS installer. macOS: DMG for installation and signed app archive for updates.\n\n${marker(build)}`,
  }), headers: { "Content-Type": "application/json" } });
}
export async function uploadDesktopPlatform(api: ReleaseAPI, build: ReleaseBuild, platform: UpdatePlatform, bundleRoot: string): Promise<void> {
  const release = await api.release(build.tag);
  if (!release?.draft || !release.body.includes(marker(build))) throw new Error("The matching draft release is unavailable.");
  const { assets, updater, signature } = collectReleaseAssets(bundleRoot, platform, build.version);
  for (const asset of assets) await api.upload(release, asset);
  const feed: DesktopFeed = { version: build.version, channel: build.channel, commit: build.sha, bundle_source: build.fingerprint,
    notes: `Lumiverse Desktop ${build.version} (${build.channel}). Desktop, server, and bundled libraries update together.`,
    pub_date: new Date().toISOString(), platforms: { [platform]: { url: `https://github.com/${api.repository}/releases/download/${build.tag}/${updater.name}`, signature } } };
  await api.upload(release, { name: `updater-${platform}.json`, contentType: "application/json", bytes: Buffer.from(JSON.stringify(feed, null, 2) + "\n") });
}
export async function publishDesktopRelease(api: ReleaseAPI, build: ReleaseBuild): Promise<void> {
  const release = await api.release(build.tag);
  if (!release || !release.body.includes(marker(build))) throw new Error("The matching release is unavailable.");
  const assets = await api.assets(release.id);
  const fragments = await Promise.all(UPDATE_PLATFORMS.map(async (platform) => {
    const asset = assets.find((asset) => asset.name === `updater-${platform}.json`);
    if (!asset) throw new Error(`The ${platform} build is missing; the update feed will not advance.`);
    return api.assetJSON(asset);
  }));
  const feed = mergeFeeds(fragments, build.channel, build.version, build.sha, build.fingerprint);
  for (const entry of Object.values(feed.platforms)) {
    if (!entry.url.startsWith(`https://github.com/${api.repository}/releases/download/${build.tag}/`)) throw new Error("Updater URLs must be pinned to this release.");
    const name = new URL(entry.url).pathname.split("/").at(-1)!;
    if (!assets.some((asset) => asset.name === name) || !assets.some((asset) => asset.name === name + ".sig")) throw new Error(`Missing signed release artifact: ${name}`);
  }
  let feeds = await api.release("desktop-updates");
  if (feeds) {
    const currentAsset = (await api.assets(feeds.id)).find((asset) => asset.name === `${build.channel}.json`);
    if (currentAsset) {
      const current = validateFeed(await api.assetJSON(currentAsset), build.channel);
      const order = Bun.semver.order(build.version, current.version);
      if (order < 0 || (order === 0 && (current.commit !== build.sha || current.bundle_source !== build.fingerprint))) {
        throw new Error("Refusing to move the update channel backward or replace an existing version with different source.");
      }
    }
  }
  // Users cannot discover incomplete builds. Publish the tested release before
  // replacing the small channel feed; payload URLs stay pinned to its version.
  if (release.draft) await api.request(`/releases/${release.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: false, make_latest: "false" }) });
  if (!feeds) {
    try {
      feeds = await api.request("/releases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        // This tag hosts metadata only. Let GitHub use the default branch:
        // GITHUB_TOKEN cannot create a tag at an older workflow-changing SHA.
        // The feed and immutable installer URLs still identify the tested build.
        tag_name: "desktop-updates", name: "Lumiverse Desktop update channels", draft: false, prerelease: true, make_latest: "false",
        body: "Small stable/nightly update feeds. Installers live on their versioned desktop releases.",
      }) });
    } catch (error) { feeds = await api.release("desktop-updates"); if (!feeds) throw error; }
  }
  if (!feeds) throw new Error("The channel feed release is unavailable.");
  await api.upload(feeds, { name: `${build.channel}.json`, contentType: "application/json", bytes: Buffer.from(JSON.stringify(feed, null, 2) + "\n") });
  // Keep failed-build assets available for retries until a newer nightly ships.
  // Cleanup errors must not turn a successfully published update into a failure.
  try { await pruneAbandonedNightlyDrafts(api, build); }
  catch (error) { console.warn(`Could not clean superseded nightly drafts: ${error instanceof Error ? error.message : String(error)}`); }
}
if (import.meta.main) {
  const channel = process.env.DESKTOP_CHANNEL;
  if (channel !== "stable" && channel !== "nightly") throw new Error("Choose stable or nightly.");
  const build: ReleaseBuild = { channel, version: process.env.DESKTOP_VERSION!, tag: process.env.DESKTOP_TAG!, sha: process.env.DESKTOP_SHA!, fingerprint: process.env.DESKTOP_SOURCE! };
  if (!build.version || !build.tag || !/^[a-f0-9]{40}$/.test(build.sha) || !/^[a-f0-9]{64}$/.test(build.fingerprint)) throw new Error("Incomplete desktop release build metadata.");
  const api = new ReleaseAPI(process.env.GITHUB_REPOSITORY!, process.env.GITHUB_TOKEN!);
  switch (process.argv[2]) {
    case "create": {
      const release = await createDesktopRelease(api, build);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `release_id=${release.id}\n`);
      break;
    }
    case "upload": {
      const platform = process.env.DESKTOP_PLATFORM as UpdatePlatform;
      if (!UPDATE_PLATFORMS.includes(platform)) throw new Error("Unsupported updater platform.");
      await uploadDesktopPlatform(api, build, platform, resolve(import.meta.dir, "..", "desktop/src-tauri/target", process.env.DESKTOP_TARGET!, "release/bundle"));
      break;
    }
    case "publish": await publishDesktopRelease(api, build); break;
    default: throw new Error("Use create, upload, or publish.");
  }
}
