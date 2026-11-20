import { ReleaseAPI, type GitHubAsset, type GitHubRelease } from "./desktop-release";

export type NightlyKind = "desktop" | "android";
type WebhookRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export const NOTIFIED_MARKER = "<!-- lumiverse-nightly-discord-notified:v1 -->";

export function nightlyPayload(repository: string, release: GitHubRelease, assets: GitHubAsset[], kind: NightlyKind) {
  const prefix = kind === "desktop" ? "desktop-v" : "android-v";
  if (release.draft || !release.tag_name.startsWith(prefix) || !release.tag_name.includes("-nightly.")) {
    throw new Error("Only published nightly releases can be announced.");
  }
  const version = release.tag_name.slice(prefix.length);
  const url = `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}`;
  const groups = kind === "desktop" ? [
    { name: "Windows", binaries: [
      ["x64 installer", `lumiverse-desktop-windows-x86_64-${version}-setup.exe`],
      ["ARM64 installer", `lumiverse-desktop-windows-aarch64-${version}-setup.exe`],
    ] },
    { name: "Linux", binaries: [
      ["x64 AppImage", `lumiverse-desktop-linux-x86_64-${version}.AppImage`],
      ["ARM64 AppImage", `lumiverse-desktop-linux-aarch64-${version}.AppImage`],
    ] },
    { name: "macOS", binaries: [
      ["Apple Silicon DMG", `lumiverse-desktop-darwin-aarch64-${version}.dmg`],
      ["Intel DMG", `lumiverse-desktop-darwin-x86_64-${version}.dmg`],
    ] },
  ] : [{ name: "Android", binaries: [["ARM64 APK", "lumiverse-tauri-arm64.apk"]] }];
  const fields = groups.flatMap(group => {
    const links = group.binaries.filter(([, name]) => assets.some(asset => asset.name === name))
      .map(([label, name]) => `[${label}](https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name!)})`);
    return links.length ? [{ name: group.name, value: links.join("\n"), inline: true }] : [];
  });
  if (!fields.length) throw new Error("The published nightly has no recognized platform binaries.");
  return {
    username: "Lumiverse Releases",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Lumiverse ${kind === "desktop" ? "Desktop" : "Android"} nightly · ${version}`,
      url,
      description: `[View release and downloads](${url})\n${kind === "desktop"
        ? "Self-contained desktop builds with the server and frontend included."
        : "Bundled APK with the backend included. Requires Android 10 or newer."}`,
      color: 0x9b87f5,
      fields,
      footer: { text: "Experimental nightly build" },
    }],
  };
}

export async function postDiscordWebhook(webhook: string, payload: ReturnType<typeof nightlyPayload>, request: WebhookRequest = fetch) {
  let url: URL;
  try { url = new URL(webhook); } catch { throw new Error("Invalid Discord webhook configuration."); }
  if (url.protocol !== "https:" || url.hostname !== "discord.com" || !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)) {
    throw new Error("Invalid Discord webhook configuration.");
  }
  url.searchParams.set("wait", "true");
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await request(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000), redirect: "error" });
    } catch {
      // Transport errors can contain the webhook token. Never log their text.
      throw new Error("Discord webhook request failed.");
    }
    if (response.ok) return;
    if (response.status === 429 && attempt < 2) {
      const rateLimit = await response.json().catch(() => null) as { retry_after?: number } | null;
      const seconds = rateLimit?.retry_after ?? Number(response.headers.get("Retry-After") ?? "NaN");
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 30) { await Bun.sleep(seconds * 1_000); continue; }
    }
    throw new Error(`Discord webhook failed (HTTP ${response.status}).`);
  }
}

export async function notifyNightlyRelease(api: ReleaseAPI, kind: NightlyKind, tag: string, webhook: string, request: WebhookRequest = fetch) {
  if (!webhook) throw new Error("Configure DISCORD_NIGHTLY_WEBHOOK_URL.");
  const release = await api.release(tag);
  if (!release) throw new Error("Published nightly release was not found.");
  const payload = nightlyPayload(api.repository, release, await api.assets(release.id), kind);
  if (release.body.includes(NOTIFIED_MARKER)) { console.log("This nightly was already announced."); return false; }
  await postDiscordWebhook(webhook, payload, request);
  // Desktop callbacks are serialized by the completion workflow. Retain a receipt
  // on the release so duplicate callbacks and reruns do not post again.
  await api.request(`/releases/${release.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: `${release.body}\n\n${NOTIFIED_MARKER}` }) });
  console.log(`Announced ${release.tag_name} in Discord.`);
  return true;
}

if (import.meta.main) {
  const kind = process.argv[2], tag = process.argv[3];
  if ((kind !== "desktop" && kind !== "android") || !tag) throw new Error("Use notify-nightly-release.ts <desktop|android> <release-tag>.");
  await notifyNightlyRelease(new ReleaseAPI(process.env.RELEASE_REPOSITORY || process.env.GITHUB_REPOSITORY!, process.env.GITHUB_TOKEN!),
    kind, tag, process.env.DISCORD_NIGHTLY_WEBHOOK_URL!);
}
