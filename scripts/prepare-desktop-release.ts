import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { releaseVersion, sourceFingerprint, validateFeed, type ReleaseChannel } from "./desktop-release";

export async function prepareDesktopRelease(options: {
  cwd: string; channel: ReleaseChannel; repository: string; runNumber: string;
  date?: Date; tagVersion?: string; readFeed?: () => Promise<unknown | null>;
}) {
  const base = (await Bun.file(resolve(options.cwd, "desktop/package.json")).json()).version as string;
  const tauri = (await Bun.file(resolve(options.cwd, "desktop/src-tauri/tauri.conf.json")).json()).version;
  const cargo = Bun.TOML.parse(await Bun.file(resolve(options.cwd, "desktop/src-tauri/Cargo.toml")).text()) as { package: { version: string } };
  const lock = Bun.TOML.parse(await Bun.file(resolve(options.cwd, "desktop/src-tauri/Cargo.lock")).text()) as { package: Array<{ name: string; version: string }> };
  if ([tauri, cargo.package.version, lock.package.find((entry) => entry.name === "lumiverse-tray")?.version].some((version) => version !== base)) {
    throw new Error("Desktop versions differ. Use bun run desktop:version to update all four manifests together.");
  }
  if (options.tagVersion && options.tagVersion !== base) throw new Error("The desktop release tag must match the committed desktop version.");
  const fingerprint = sourceFingerprint(options.cwd);
  const readFeed = options.readFeed || (async () => {
    const response = await fetch(`https://github.com/${options.repository}/releases/download/desktop-updates/${options.channel}.json`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Could not read the previous ${options.channel} feed (${response.status})`);
    return response.json();
  });
  const previous = await readFeed();
  const feed = previous === null ? null : validateFeed(previous, options.channel);
  const version = releaseVersion(base, options.channel, options.date || new Date(), options.runNumber);
  if (feed?.bundle_source === fingerprint) return { build: false, version, fingerprint };
  if (feed && Bun.semver.order(version, feed.version) <= 0) {
    throw new Error("Bump the desktop version before publishing another bundled release; the new version must be newer than its channel feed.");
  }
  return { build: true, version, fingerprint };
}
if (import.meta.main) {
  const channel = process.env.DESKTOP_CHANNEL;
  if (channel !== "stable" && channel !== "nightly") throw new Error("Choose stable or nightly.");
  const result = await prepareDesktopRelease({ cwd: resolve(import.meta.dir, ".."), channel,
    // Run IDs are unique across the scheduled and manual workflow entry points.
    repository: process.env.GITHUB_REPOSITORY || "prolix-oc/Lumiverse", runNumber: process.env.GITHUB_RUN_ID || process.env.GITHUB_RUN_NUMBER || "1",
    tagVersion: process.env.DESKTOP_TAG_VERSION || undefined });
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" });
  if (sha.exitCode !== 0) throw new Error("Could not resolve release source.");
  const output = `build=${result.build}\nversion=${result.version}\nfingerprint=${result.fingerprint}\nsha=${new TextDecoder().decode(sha.stdout).trim()}\ntag=desktop-v${result.version}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  console.log(output);
}
