import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReleaseAssets, mergeFeeds, releaseVersion, ReleaseAPI, sourceFingerprint, UPDATE_PLATFORMS, validateFeed, type DesktopFeed, type UpdatePlatform } from "./desktop-release";
import { prepareDesktopRelease } from "./prepare-desktop-release";
import { createDesktopRelease, pruneAbandonedNightlyDrafts, publishDesktopRelease, uploadDesktopPlatform, type ReleaseBuild } from "./publish-desktop-release";
import { resignFinalizedAppImages } from "./tauri-finalized";

const temporary: string[] = [];
function directory(): string { const path = mkdtempSync(join(tmpdir(), "lumiverse-desktop-release-")); temporary.push(path); return path; }
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const build: ReleaseBuild = { channel: "nightly", version: "0.3.2-nightly.20261014.42", tag: "desktop-v0.3.2-nightly.20261014.42", sha: "a".repeat(40), fingerprint: "b".repeat(64) };
function feed(overrides: Partial<DesktopFeed> = {}): DesktopFeed {
  return { version: build.version, channel: "nightly", notes: "fixture", pub_date: new Date().toISOString(), commit: build.sha, bundle_source: build.fingerprint,
    platforms: Object.fromEntries(UPDATE_PLATFORMS.map((platform) => [platform, { signature: "signed-fixture", url: `https://github.com/test/Lumiverse/releases/download/${build.tag}/${platform}` }])), ...overrides };
}
function bundle(platform: UpdatePlatform) {
  const root = directory();
  const folder = join(root, platform.startsWith("linux") ? "appimage" : platform.startsWith("darwin") ? "macos" : "nsis");
  mkdirSync(folder);
  const suffix = platform.startsWith("linux") ? ".AppImage" : platform.startsWith("darwin") ? ".app.tar.gz" : "-setup.exe";
  const artifact = join(folder, "Lumiverse Desktop" + suffix);
  writeFileSync(artifact, "finalized-payload"); writeFileSync(artifact + ".sig", "signed-finalized-payload");
  if (platform.startsWith("darwin")) { mkdirSync(join(root, "dmg")); writeFileSync(join(root, "dmg", "Lumiverse.dmg"), "installer"); }
  return { root, folder, artifact };
}
test("nightly versions advance from the stable base and distinguish daily builds", () => {
  expect(releaseVersion("0.3.1", "nightly", new Date("2026-10-14T05:23:00Z"), "42")).toBe(build.version);
  expect(releaseVersion("0.3.1", "stable", new Date(), "42")).toBe("0.3.1");
  expect(() => releaseVersion("0.3.1", "nightly", new Date(), "0")).toThrow();
  expect(() => releaseVersion("0.3.1-beta", "stable", new Date(), "42")).toThrow();
});
test("nightly skips unrelated commits and rebuilds when shipped source changes", async () => {
  const cwd = directory(); mkdirSync(join(cwd, "desktop")); mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "desktop/package.json"), JSON.stringify({ version: "0.3.1" }));
  mkdirSync(join(cwd, "desktop/src-tauri"));
  writeFileSync(join(cwd, "desktop/src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.3.1" }));
  writeFileSync(join(cwd, "desktop/src-tauri/Cargo.toml"), '[package]\nversion = "0.3.1"\n');
  writeFileSync(join(cwd, "desktop/src-tauri/Cargo.lock"), '[[package]]\nname = "lumiverse-tray"\nversion = "0.3.1"\n');
  writeFileSync(join(cwd, "src/main.ts"), "export const version = 1;");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Release Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: join(cwd, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  git("init"); git("add", "."); git("commit", "-m", "Fixture");
  const fingerprint = sourceFingerprint(cwd);
  const previous = feed({ bundle_source: fingerprint });
  const prepare = () => prepareDesktopRelease({ cwd, channel: "nightly", repository: "test/Lumiverse", runNumber: "43", date: new Date("2026-10-14T05:23:00Z"), readFeed: async () => previous });
  expect((await prepare()).build).toBe(false);
  writeFileSync(join(cwd, "README.md"), "Unshipped documentation change"); git("add", "."); git("commit", "-m", "Docs");
  expect(sourceFingerprint(cwd)).toBe(fingerprint);
  expect((await prepare()).build).toBe(false);
  writeFileSync(join(cwd, "desktop/README.md"), "Unshipped desktop docs");
  writeFileSync(join(cwd, "desktop/LINUX-VALIDATION.md"), "Unshipped hardware qualification notes");
  writeFileSync(join(cwd, "src/main.test.ts"), "Unshipped server test");
  git("add", "."); git("commit", "-m", "Desktop docs and tests");
  expect(sourceFingerprint(cwd)).toBe(fingerprint);
  expect((await prepare()).build).toBe(false);
  mkdirSync(join(cwd, "scripts"));
  const beforeCrossBuilder = sourceFingerprint(cwd);
  writeFileSync(join(cwd, "scripts/linux-arm64-cross.ts"), "changed ARM64 artifact validation");
  git("add", "."); git("commit", "-m", "Cross-builder change");
  expect(sourceFingerprint(cwd)).not.toBe(beforeCrossBuilder);
  expect((await prepare()).build).toBe(true);
  writeFileSync(join(cwd, "scripts/appimage-apprun.sh"), "changed launcher environment policy");
  git("add", "."); git("commit", "-m", "Launcher change");
  expect((await prepare()).build).toBe(true);
  writeFileSync(join(cwd, "src/main.ts"), "export const version = 2;"); git("add", "."); git("commit", "-m", "Server change");
  expect((await prepare()).build).toBe(true);
  await expect(prepareDesktopRelease({ cwd, channel: "nightly", repository: "test/Lumiverse", runNumber: "41", date: new Date("2026-10-14T05:23:00Z"), readFeed: async () => previous })).rejects.toThrow("must be newer");
  await expect(prepareDesktopRelease({ cwd, channel: "stable", repository: "test/Lumiverse", runNumber: "1", readFeed: async () => feed({ channel: "stable", version: "0.3.1", bundle_source: fingerprint }) })).rejects.toThrow("Bump the desktop version");
  await expect(prepareDesktopRelease({ cwd, channel: "stable", repository: "test/Lumiverse", runNumber: "1", tagVersion: "0.3.2", readFeed: async () => null })).rejects.toThrow("tag must match");
  writeFileSync(join(cwd, "desktop/src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.4.0" }));
  await expect(prepare()).rejects.toThrow("Desktop versions differ");
// This fixture starts many Git processes; Windows process startup can exceed
// Bun's five-second default even when every assertion passes.
}, 60_000);
test("feeds require every architecture and cannot mix channels, commits, or signatures", () => {
  expect(validateFeed(feed(), "nightly").version).toBe(build.version);
  expect(() => validateFeed(feed({ channel: "stable" }), "nightly")).toThrow();
  const missing = feed(); delete missing.platforms["darwin-x86_64"];
  expect(() => validateFeed(missing, "nightly")).toThrow("darwin-x86_64");
  const unsigned = feed(); unsigned.platforms["linux-x86_64"]!.signature = "";
  expect(() => validateFeed(unsigned, "nightly")).toThrow();
  expect(() => mergeFeeds([feed(), feed()], "nightly", build.version, build.sha, build.fingerprint)).toThrow("Duplicate");
  expect(() => mergeFeeds([feed({ commit: "c".repeat(40) })], "nightly", build.version, build.sha, build.fingerprint)).toThrow("different builds");
});
test("Linux releases select only the signed AppImage, excluding Debian packages", () => {
  const fixture = bundle("linux-x86_64"); mkdirSync(join(fixture.root, "deb")); writeFileSync(join(fixture.root, "deb", "Lumiverse.deb"), "duplicate installer");
  const result = collectReleaseAssets(fixture.root, "linux-x86_64", build.version);
  expect(result.assets.map((asset) => asset.name)).toEqual([`lumiverse-desktop-linux-x86_64-${build.version}.AppImage`, `lumiverse-desktop-linux-x86_64-${build.version}.AppImage.sig`]);
  rmSync(fixture.artifact + ".sig"); expect(() => collectReleaseAssets(fixture.root, "linux-x86_64", build.version)).toThrow("Missing updater signature");
});
test("finalized AppImages replace their original signatures; unsigned development builds need no key", async () => {
  const fixture = bundle("linux-x86_64"); writeFileSync(fixture.artifact + ".sig", "old-signature");
  const signed: string[] = [];
  await resignFinalizedAppImages(fixture.folder, async (artifact) => { signed.push(readFileSync(artifact, "utf8")); writeFileSync(artifact + ".sig", "new-signature"); });
  expect(signed).toEqual(["finalized-payload"]);
  expect(readFileSync(fixture.artifact + ".sig", "utf8")).toBe("new-signature");
  rmSync(fixture.artifact + ".sig");
  await resignFinalizedAppImages(fixture.folder, async () => { throw new Error("Unsigned builds must not request a signing key"); });
});

function githubFixture(options: { restrictFeedTarget?: boolean; denyDraftDeletion?: boolean } = {}) {
  type Release = { id: number; draft: boolean; body: string; upload_url: string; tag_name: string; target_commitish?: string };
  type Asset = { id: number; name: string; browser_download_url: string; bytes: Uint8Array };
  const releases: Release[] = [], assets = new Map<number, Asset[]>(), calls: string[] = [];
  const runs = new Map<string, { status: string; conclusion: string | null; head_sha: string; path: string }>();
  let nextReleaseId = 1;
  let failFeed = false;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const transport = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), method = init.method || "GET";
    const path = url.pathname.replace("/repos/test/Lumiverse", "");
    calls.push(`${method} ${path}${url.search}`);
    const run = path.match(/^\/actions\/runs\/(\d+)$/);
    if (run) return json(runs.get(run[1]!) || {}, runs.has(run[1]!) ? 200 : 404);
    if (path.startsWith("/releases/tags/")) {
      const published = releases.find((release) => !release.draft && release.tag_name === decodeURIComponent(path.slice(15)));
      return json(published || {}, published ? 200 : 404);
    }
    if (path === "/releases" && method === "GET") {
      const page = Number(url.searchParams.get("page") || 1), count = Number(url.searchParams.get("per_page") || 100);
      return json(releases.slice((page - 1) * count, page * count));
    }
    if (path === "/releases" && method === "POST") {
      const body = JSON.parse(String(init.body));
      if (options.restrictFeedTarget && body.tag_name === "desktop-updates" && body.target_commitish === build.sha) {
        return json({ message: "Resource not accessible by integration" }, 403);
      }
      const id = nextReleaseId++;
      const release = { ...body, id, upload_url: `https://uploads.github.com/repos/test/Lumiverse/releases/${id}/assets{?name}` };
      releases.push(release); assets.set(release.id, []); return json(release);
    }
    const collection = path.match(/^\/releases\/(\d+)\/assets$/);
    if (collection) {
      const id = Number(collection[1]);
      if (method === "GET") return json(assets.get(id));
      const name = url.searchParams.get("name")!;
      if (failFeed && name === "nightly.json") { failFeed = false; return json({ message: "Temporary failure" }, 503); }
      const bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      const asset = { id: [...assets.values()].flat().length + 100, name, browser_download_url: "https://github.com/fixture", bytes };
      assets.get(id)!.push(asset); return json(asset);
    }
    const release = path.match(/^\/releases\/(\d+)$/);
    if (release && method === "GET") {
      const item = releases.find((item) => item.id === Number(release[1]));
      return json(item || {}, item ? 200 : 404);
    }
    if (release && method === "DELETE") {
      if (options.denyDraftDeletion) return json({ message: "Deletion unavailable" }, 403);
      const index = releases.findIndex((item) => item.id === Number(release[1]));
      if (index < 0) return json({}, 404);
      assets.delete(releases[index]!.id); releases.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (release && method === "PATCH") {
      Object.assign(releases.find((item) => item.id === Number(release[1]))!, JSON.parse(String(init.body)));
      return json(releases.find((item) => item.id === Number(release[1])));
    }
    const asset = path.match(/^\/releases\/assets\/(\d+)$/);
    if (asset) {
      for (const list of assets.values()) {
        const index = list.findIndex((item) => item.id === Number(asset[1])); if (index < 0) continue;
        if (method === "DELETE") { list.splice(index, 1); return new Response(null, { status: 204 }); }
        return new Response(new Uint8Array(list[index]!.bytes));
      }
    }
    throw new Error(`Unhandled fixture request: ${method} ${path}`);
  }) as typeof fetch;
  return { api: new ReleaseAPI("test/Lumiverse", "test-token", transport), releases, assets, calls, runs, failNextFeed: () => { failFeed = true; } };
}
test("draft releases are found and reused before GitHub creates their tags", async () => {
  const fixture = githubFixture();
  const created = await createDesktopRelease(fixture.api, build);
  expect((await fixture.api.release(build.tag))?.id).toBe(created.id);
  expect((await createDesktopRelease(fixture.api, build)).id).toBe(created.id);
  expect(fixture.releases).toHaveLength(1);
  expect(fixture.calls).toContain("GET /releases?per_page=100&page=1");
});
test("partial matrix results never publish a release or advance the channel feed", async () => {
  const fixture = githubFixture(); await createDesktopRelease(fixture.api, build);
  for (const platform of UPDATE_PLATFORMS.slice(0, -1)) await uploadDesktopPlatform(fixture.api, build, platform, bundle(platform).root);
  await expect(publishDesktopRelease(fixture.api, build)).rejects.toThrow("windows-aarch64 build is missing");
  expect(fixture.releases[0]!.draft).toBe(true);
  expect(fixture.releases).toHaveLength(1);
  const last = UPDATE_PLATFORMS.at(-1)!; await uploadDesktopPlatform(fixture.api, build, last, bundle(last).root);
  await publishDesktopRelease(fixture.api, build);
  expect(fixture.releases[0]!.draft).toBe(false);
  const channel = fixture.releases.find((release) => release.tag_name === "desktop-updates")!;
  const asset = fixture.assets.get(channel.id)!.find((asset) => asset.name === "nightly.json")!;
  const published = validateFeed(JSON.parse(new TextDecoder().decode(asset.bytes)), "nightly");
  expect(Object.keys(published.platforms).sort()).toEqual([...UPDATE_PLATFORMS].sort());
  expect(fixture.calls.findIndex((call) => call.startsWith("PATCH"))).toBeLessThan(fixture.calls.findIndex((call) => call.includes("name=nightly.json")));
  await expect(createDesktopRelease(fixture.api, build)).rejects.toThrow("Refusing to overwrite");
});
test("a failed channel upload can retry without replacing published payloads", async () => {
  const fixture = githubFixture(); await createDesktopRelease(fixture.api, build);
  for (const platform of UPDATE_PLATFORMS) await uploadDesktopPlatform(fixture.api, build, platform, bundle(platform).root);
  fixture.failNextFeed(); await expect(publishDesktopRelease(fixture.api, build)).rejects.toThrow("asset upload failed");
  expect(fixture.releases[0]!.draft).toBe(false);
  await publishDesktopRelease(fixture.api, build);
  expect(fixture.releases.find((release) => release.tag_name === "desktop-updates")).toBeDefined();
  expect(fixture.calls.filter((call) => call.startsWith("PATCH"))).toHaveLength(1);
});
test("a channel can bootstrap with a restricted workflow token after the source branch advances", async () => {
  const fixture = githubFixture({ restrictFeedTarget: true });
  await createDesktopRelease(fixture.api, build);
  for (const platform of UPDATE_PLATFORMS) await uploadDesktopPlatform(fixture.api, build, platform, bundle(platform).root);
  await publishDesktopRelease(fixture.api, build);
  const channel = fixture.releases.find((release) => release.tag_name === "desktop-updates")!;
  expect(channel.target_commitish).toBeUndefined();
  expect(fixture.releases[0]!.target_commitish).toBe(build.sha);
  const asset = fixture.assets.get(channel.id)!.find((asset) => asset.name === "nightly.json")!;
  const published = validateFeed(JSON.parse(new TextDecoder().decode(asset.bytes)), "nightly");
  expect(published.commit).toBe(build.sha);
  expect(published.bundle_source).toBe(build.fingerprint);
  expect(Object.values(published.platforms).every((entry) => entry.url.includes(`/releases/download/${build.tag}/`))).toBe(true);
  await publishDesktopRelease(fixture.api, build);
  expect(fixture.calls.filter((call) => call.startsWith("PATCH"))).toHaveLength(1);
});
test("rerunning an old publication cannot move a channel backward", async () => {
  const fixture = githubFixture();
  const newer = { ...build, version: "0.3.2-nightly.20261014.43", tag: "desktop-v0.3.2-nightly.20261014.43", sha: "c".repeat(40), fingerprint: "d".repeat(64) };
  for (const release of [build, newer]) {
    await createDesktopRelease(fixture.api, release);
    for (const platform of UPDATE_PLATFORMS) await uploadDesktopPlatform(fixture.api, release, platform, bundle(platform).root);
    await publishDesktopRelease(fixture.api, release);
  }
  const calls = fixture.calls.length;
  await expect(publishDesktopRelease(fixture.api, build)).rejects.toThrow("move the update channel backward");
  expect(fixture.calls.slice(calls).every((call) => call.startsWith("GET"))).toBe(true);
  const channel = fixture.releases.find((release) => release.tag_name === "desktop-updates")!;
  const asset = fixture.assets.get(channel.id)!.find((asset) => asset.name === "nightly.json")!;
  expect(validateFeed(JSON.parse(new TextDecoder().decode(asset.bytes)), "nightly").version).toBe(newer.version);
});
test("cleanup removes only older owned drafts from unsuccessful completed runs, across pages", async () => {
  const fixture = githubFixture();
  const published = await createDesktopRelease(fixture.api, { ...build, tag: "desktop-v0.3.1", channel: "stable", version: "0.3.1" });
  fixture.releases[0]!.draft = false;
  // Push the candidates past the first API page without touching published history.
  for (let index = 0; index < 99; index++) fixture.releases.push({ ...fixture.releases[0]!, id: 1000 + index, tag_name: `historical-${index}` });
  const cases = [
    { run: "1", conclusion: "failure", remove: true },
    { run: "2", conclusion: "cancelled", remove: true },
    { run: "3", conclusion: "timed_out", remove: true },
    { run: "4", status: "in_progress", conclusion: null, remove: false },
    { run: "5", status: "queued", conclusion: null, remove: false },
    { run: "6", conclusion: "success", remove: false },
    { run: "7", conclusion: "failure", source: "c".repeat(40), remove: false },
    { run: "8", conclusion: "failure", draft: false, remove: false },
    { run: "9", conclusion: "failure", owned: false, remove: false },
    { run: "10", conclusion: "failure", tag: "unrelated-nightly", remove: false },
    { run: "11", conclusion: "failure", tag: "desktop-v0.3.0", remove: false },
    { run: "12", conclusion: "failure", tag: "desktop-v0.3.2-nightly.20261015.12", remove: false },
    { run: "42", conclusion: "failure", tag: build.tag, remove: false },
    { run: "13", conclusion: "failure", path: ".github/workflows/unrelated.yml", remove: false },
  ];
  for (const item of cases) {
    const tag = item.tag ?? `desktop-v0.3.2-nightly.20261013.${item.run}`;
    const release = await createDesktopRelease(fixture.api, { ...build, tag });
    const record = fixture.releases.find((entry) => entry.id === release.id)!;
    record.draft = item.draft ?? true;
    record.target_commitish = item.source ?? build.sha;
    if (item.owned === false) record.body = "Unrelated draft without bundled source metadata";
    // Scheduled workflows execute from main even though they bundle staging.
    fixture.runs.set(item.run, { status: item.status ?? "completed", conclusion: item.conclusion, head_sha: "c".repeat(40), path: item.path ?? ".github/workflows/desktop-nightly.yml" });
  }
  await pruneAbandonedNightlyDrafts(fixture.api, build);
  expect(fixture.calls).toContain("GET /releases?per_page=100&page=2");
  expect(fixture.releases.some((item) => item.id === published.id)).toBe(true);
  for (const item of cases) {
    const tag = item.tag ?? `desktop-v0.3.2-nightly.20261013.${item.run}`;
    expect(fixture.releases.some((release) => release.tag_name === tag)).toBe(!item.remove);
  }
  expect(fixture.calls.filter((call) => call.startsWith("DELETE /releases/")).length).toBe(3);
  const calls = fixture.calls.length;
  await pruneAbandonedNightlyDrafts(fixture.api, { ...build, channel: "stable", version: "0.3.1" });
  expect(fixture.calls).toHaveLength(calls);
});
test("abandoned draft cleanup waits until the newer channel feed uploads successfully", async () => {
  const fixture = githubFixture();
  const old = await createDesktopRelease(fixture.api, build);
  fixture.runs.set("42", { status: "completed", conclusion: "cancelled", head_sha: build.sha, path: ".github/workflows/desktop-build.yml" });
  const newer = { ...build, version: "0.3.2-nightly.20261014.43", tag: "desktop-v0.3.2-nightly.20261014.43" };
  await createDesktopRelease(fixture.api, newer);
  for (const platform of UPDATE_PLATFORMS) await uploadDesktopPlatform(fixture.api, newer, platform, bundle(platform).root);
  fixture.failNextFeed();
  await expect(publishDesktopRelease(fixture.api, newer)).rejects.toThrow("asset upload failed");
  expect(fixture.releases.some((release) => release.id === old.id && release.draft)).toBe(true);
  await publishDesktopRelease(fixture.api, newer);
  expect(fixture.releases.some((release) => release.id === old.id)).toBe(false);
  const deleted = fixture.calls.indexOf(`DELETE /releases/${old.id}`);
  const uploaded = fixture.calls.findLastIndex((call) => call.includes("name=nightly.json"));
  expect(deleted).toBeGreaterThan(uploaded);
});
test("cleanup errors preserve a successful publication and its signed feed", async () => {
  const fixture = githubFixture({ denyDraftDeletion: true });
  const old = await createDesktopRelease(fixture.api, build);
  fixture.runs.set("42", { status: "completed", conclusion: "failure", head_sha: build.sha, path: ".github/workflows/desktop-build.yml" });
  const newer = { ...build, version: "0.3.2-nightly.20261014.43", tag: "desktop-v0.3.2-nightly.20261014.43" };
  await createDesktopRelease(fixture.api, newer);
  for (const platform of UPDATE_PLATFORMS) await uploadDesktopPlatform(fixture.api, newer, platform, bundle(platform).root);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await publishDesktopRelease(fixture.api, newer);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(fixture.releases.some((release) => release.id === old.id)).toBe(true);
    expect(fixture.releases.find((release) => release.tag_name === newer.tag)?.draft).toBe(false);
    const channel = fixture.releases.find((release) => release.tag_name === "desktop-updates")!;
    const asset = fixture.assets.get(channel.id)!.find((asset) => asset.name === "nightly.json")!;
    expect(validateFeed(JSON.parse(new TextDecoder().decode(asset.bytes)), "nightly").version).toBe(newer.version);
  } finally { warning.mockRestore(); }
});
