import { expect, test } from "bun:test";
import { ReleaseAPI, type GitHubAsset, type GitHubRelease } from "./desktop-release";
import { nightlyPayload, notifyNightlyRelease, NOTIFIED_MARKER, postDiscordWebhook } from "./notify-nightly-release";

const version = "0.3.2-nightly.20261029.1234";
const repository = "test/Lumiverse";
const webhook = "https://discord.com/api/webhooks/1234/fixture-token";
const release: GitHubRelease = { id: 7, draft: false, body: "Original release notes", upload_url: "", target_commitish: "a".repeat(40), tag_name: `desktop-v${version}` };
const asset = (name: string): GitHubAsset => ({ id: 1, name, browser_download_url: "https://github.com/unused" });
const assets = [
  ...["x86_64", "aarch64"].flatMap(arch => [
    asset(`lumiverse-desktop-windows-${arch}-${version}-setup.exe`),
    asset(`lumiverse-desktop-linux-${arch}-${version}.AppImage`),
    asset(`lumiverse-desktop-darwin-${arch}-${version}.dmg`),
    asset(`lumiverse-desktop-darwin-${arch}-${version}.app.tar.gz`),
  ]),
  asset("updater-linux-x86_64.json"), asset(`lumiverse-desktop-linux-x86_64-${version}.AppImage.sig`),
];

test("desktop payload links the release and six published installers by platform", () => {
  const payload = nightlyPayload(repository, release, assets, "desktop"), embed = payload.embeds[0]!;
  expect(payload.allowed_mentions.parse).toEqual([]);
  expect(embed.url).toBe(`https://github.com/${repository}/releases/tag/${release.tag_name}`);
  expect(embed.fields.map(field => field.name)).toEqual(["Windows", "Linux", "macOS"]);
  expect(embed.fields.flatMap(field => field.value.split("\n"))).toHaveLength(6);
  expect(embed.fields[2]!.value).toContain("Apple Silicon DMG");
  const content = JSON.stringify(payload);
  expect(content).not.toContain(".sig");
  expect(content).not.toContain("updater-");
  expect(content).not.toContain(".app.tar.gz");
  expect(content).toContain(`/releases/download/${release.tag_name}/lumiverse-desktop-linux-aarch64-${version}.AppImage`);
});

test("payload lists only binaries present in the published assets", () => {
  const payload = nightlyPayload(repository, release, [assets[0]!], "desktop");
  expect(payload.embeds[0]!.fields).toHaveLength(1);
  expect(payload.embeds[0]!.fields[0]!.name).toBe("Windows");
  expect(payload.embeds[0]!.fields[0]!.value).toContain("x64 installer");
  expect(payload.embeds[0]!.fields[0]!.value).not.toContain("ARM64");
});

test("Android payload links only the ARM64 APK, excluding checksum and provenance files", () => {
  const payload = nightlyPayload("test/Android", { ...release, tag_name: `android-v${version}` },
    [asset("lumiverse-tauri-arm64.apk"), asset("lumiverse-tauri-arm64.apk.sha256"), asset("provenance.json")], "android");
  expect(payload.embeds[0]!.title).toContain("Android nightly");
  expect(payload.embeds[0]!.description).toContain("Android 10");
  expect(payload.embeds[0]!.fields).toEqual([{ name: "Android", inline: true,
    value: `[ARM64 APK](https://github.com/test/Android/releases/download/android-v${version}/lumiverse-tauri-arm64.apk)` }]);
});

test("draft, stable, wrong-kind and metadata-only releases cannot be announced", () => {
  for (const invalid of [{ ...release, draft: true }, { ...release, tag_name: "desktop-v0.3.2" }, { ...release, tag_name: `android-v${version}` }]) {
    expect(() => nightlyPayload(repository, invalid, assets, "desktop")).toThrow("Only published nightly");
  }
  expect(() => nightlyPayload(repository, release, [asset("provenance.json")], "desktop")).toThrow("no recognized platform binaries");
});

function fixture() {
  const current = { ...release }, calls: string[] = [];
  const request = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)); calls.push(`${init.method || "GET"} ${url.pathname}`);
    if (url.pathname.includes("/assets")) return Response.json(assets);
    if (init.method === "PATCH") Object.assign(current, JSON.parse(String(init.body)));
    return Response.json(current);
  }) as typeof fetch;
  return { api: new ReleaseAPI(repository, "github-test-token", request), current, calls };
}

test("successful delivery is confirmed and recorded so duplicate callbacks do not post again", async () => {
  const { api, current } = fixture();
  let posts = 0;
  const request = (async (input: RequestInfo | URL, init: RequestInit) => {
    posts++;
    expect(new URL(String(input)).searchParams.get("wait")).toBe("true");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(current.body).not.toContain(NOTIFIED_MARKER);
    expect(JSON.parse(String(init.body)).embeds[0].url).toContain(release.tag_name);
    return Response.json({ id: "discord-message" });
  }) as typeof fetch;
  expect(await notifyNightlyRelease(api, "desktop", release.tag_name, webhook, request)).toBe(true);
  expect(current.body).toBe(`Original release notes\n\n${NOTIFIED_MARKER}`);
  expect(await notifyNightlyRelease(api, "desktop", release.tag_name, webhook, request)).toBe(false);
  expect(posts).toBe(1);
});

test("Discord failures leave no receipt and never expose the webhook token", async () => {
  for (const request of [
    async () => { throw new Error(`Network failure at ${webhook}`); },
    async () => new Response(webhook, { status: 400 }),
  ]) {
    const { api, current, calls } = fixture();
    let error: unknown;
    try { await notifyNightlyRelease(api, "desktop", release.tag_name, webhook, request); }
    catch (caught) { error = caught; }
    expect(String(error)).toContain("Discord webhook");
    expect(String(error)).not.toContain("fixture-token");
    expect(current.body).toBe("Original release notes");
    expect(calls.some(call => call.startsWith("PATCH"))).toBe(false);
  }
});

test("missing secrets and draft releases never contact Discord", async () => {
  const { api, current } = fixture();
  const request = async () => { throw new Error("Must not post"); };
  await expect(notifyNightlyRelease(api, "desktop", release.tag_name, "", request)).rejects.toThrow("Configure DISCORD_NIGHTLY_WEBHOOK_URL");
  current.draft = true;
  await expect(notifyNightlyRelease(api, "desktop", release.tag_name, webhook, request)).rejects.toThrow("Only published nightly");
});

test("Discord rate limits are retried within a bounded delay", async () => {
  let attempts = 0;
  const request = async () => ++attempts < 3 ? Response.json({ retry_after: 0 }, { status: 429 }) : Response.json({ id: "sent" });
  await postDiscordWebhook(webhook, nightlyPayload(repository, release, assets, "desktop"), request);
  expect(attempts).toBe(3);
  await expect(postDiscordWebhook(webhook, nightlyPayload(repository, release, assets, "desktop"),
    async () => Response.json({ retry_after: 60 }, { status: 429 }))).rejects.toThrow("HTTP 429");
});
