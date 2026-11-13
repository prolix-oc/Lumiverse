import { appendFileSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ReleaseAPI } from "./desktop-release";
import { publishDesktopRelease, type ReleaseBuild } from "./publish-desktop-release";

// Keep this module and callback filename stable for in-flight Linux releases.
// Version 2 requests also route Windows builds through the private controller.
export const SOURCE_REPOSITORY = "prolix-oc/Lumiverse";
export const BUILDER_REPOSITORY = "prolix-oc/Lumiverse-Builds";
export const LINUX_TARGETS = { x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" } as const;
export const WINDOWS_TARGETS = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" } as const;
export const MACOS_TARGET = "x86_64-apple-darwin";
export type PrivateBuilder = "linux" | "windows" | "macos";
export const PRIVATE_BUILDERS = ["linux", "windows", "macos"] as const;
const workflowPath = (builder: PrivateBuilder) => `.github/workflows/${builder}-release.yml`;
export function hostedReleasePlatforms(channel: string) {
  if (channel !== "nightly" && channel !== "stable") throw new Error("Unsupported release channel");
  const platforms = [
    { os: "macos-15", platform: "darwin-aarch64", target: "aarch64-apple-darwin", bundles: "app,dmg" },
    { os: "macos-15-intel", platform: "darwin-x86_64", target: "x86_64-apple-darwin", bundles: "app,dmg" },
    { os: "ubuntu-22.04", platform: "linux-x86_64", target: "x86_64-unknown-linux-gnu", bundles: "appimage" },
    { os: "ubuntu-22.04-arm", platform: "linux-aarch64", target: "aarch64-unknown-linux-gnu", bundles: "appimage" },
    { os: "windows-2022", platform: "windows-x86_64", target: "x86_64-pc-windows-msvc", bundles: "nsis" },
    { os: "windows-11-arm", platform: "windows-aarch64", target: "aarch64-pc-windows-msvc", bundles: "nsis" },
  ];
  return platforms.filter(p => p.platform !== "darwin-x86_64" && !p.platform.startsWith("windows-") && (channel === "stable" || !p.platform.startsWith("linux-")));
}
export interface LinuxReleaseRequest extends ReleaseBuild {
  format: 1 | 2 | 3; repository: string; run: string; attempt: string; publicKey: string;
  builders?: PrivateBuilder[];
}
export const requestedBuilders = (request: LinuxReleaseRequest): PrivateBuilder[] => request.format === 1 ? ["linux"] : request.builders!;
interface Run {
  id: number; run_attempt: number; event: string; path: string; head_branch: string;
  status: string; conclusion: string | null; display_title: string;
  repository: { full_name: string }; head_repository: { full_name: string };
}
interface Artifact { id: number; name: string; size_in_bytes: number; expired: boolean }
export class NoReleaseRequestError extends Error {}
export function validateRequest(value: unknown): LinuxReleaseRequest {
  const request = value as LinuxReleaseRequest;
  if (!request || ![1, 2, 3].includes(request.format) || request.repository !== SOURCE_REPOSITORY
    || !["nightly", "stable"].includes(request.channel)
    || (request.format === 1 && (request.channel !== "nightly" || request.builders !== undefined))
    || (request.format === 2 && JSON.stringify(request.builders) !== JSON.stringify(request.channel === "nightly" ? ["linux", "windows"] : ["windows"]))
    || (request.format === 3 && JSON.stringify(request.builders) !== JSON.stringify(request.channel === "nightly" ? ["linux", "windows", "macos"] : ["windows", "macos"]))
    || !/^[1-9]\d*$/.test(request.run) || !/^[1-9]\d*$/.test(request.attempt)
    || (request.channel === "nightly"
      ? !/^\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/.test(request.version) || request.version.split(".").at(-1) !== request.run
      : !/^\d+\.\d+\.\d+$/.test(request.version))
    || request.tag !== `desktop-v${request.version}`
    || !/^[a-f0-9]{40}$/.test(request.sha) || !/^[a-f0-9]{64}$/.test(request.fingerprint)
    || !/^[A-Za-z0-9+/=]{20,512}$/.test(request.publicKey)) throw new Error("Invalid private desktop release request");
  return request;
}
export function validateParent(run: Run, request: LinuxReleaseRequest) {
  if (String(run.id) !== request.run || run.run_attempt !== Number(request.attempt)
    || run.repository.full_name !== SOURCE_REPOSITORY || run.head_repository.full_name !== SOURCE_REPOSITORY
    || (request.channel === "nightly"
      ? !["workflow_dispatch", "schedule"].includes(run.event) || !["main", "staging"].includes(run.head_branch)
        || ![".github/workflows/desktop-build.yml", ".github/workflows/desktop-nightly.yml"].includes(run.path)
      : run.path !== ".github/workflows/desktop-release.yml"
        || !(run.event === "workflow_dispatch" && run.head_branch === "main" || run.event === "push" && run.head_branch === request.tag))) {
    throw new Error("Release request does not belong to a trusted desktop workflow run");
  }
}
export const builderRunName = (request: LinuxReleaseRequest, builder: PrivateBuilder = "linux") => `${{ linux: "Linux", windows: "Windows", macos: "macOS" }[builder]} release ${request.run}.${request.attempt}`;
export const outputArtifactName = (request: LinuxReleaseRequest, builder: PrivateBuilder = "linux") => `${builder}-release-${request.run}-${request.attempt}`;
export const qualificationArtifactName = (request: LinuxReleaseRequest) => `windows-qualification-${request.run}-${request.attempt}`;
export class BridgeAPI {
  constructor(readonly token: string, readonly repository: string, readonly transport: typeof fetch = fetch) {
    if (!token) throw new Error("LINUX_RELEASE_BRIDGE_TOKEN is required for cross-repository Actions access");
  }
  async response(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await this.transport(`https://api.github.com/repos/${this.repository}${path}`, {
      method, headers: {
        Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub Actions request failed (${response.status}): ${path}`), { status: response.status });
    return response;
  }
  async json<T>(path: string, body?: unknown): Promise<T> { return (await this.response(path, body)).json() as Promise<T>; }
  async deleteArtifact(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid artifact identity");
    try { await this.response(`/actions/artifacts/${id}`, undefined, "DELETE"); }
    catch (error) {
      // Linux, Windows and scheduled maintenance can select the same handoff.
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  async artifacts(run: string): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.json<{ artifacts: Artifact[] }>(`/actions/runs/${run}/artifacts?per_page=100&page=${page}`);
      artifacts.push(...batch.artifacts);
      if (batch.artifacts.length < 100) return artifacts;
    }
  }
}
/** Published installers replace these temporary private signing handoffs. */
export async function cleanupPublishedBuildArtifacts(privateApi: BridgeAPI, releaseApi: ReleaseAPI, request: LinuxReleaseRequest) {
  if (privateApi.repository !== BUILDER_REPOSITORY || releaseApi.repository !== SOURCE_REPOSITORY) throw new Error("Unexpected release cleanup repositories");
  const release = await releaseApi.release(request.tag);
  if (!release || release.draft || !release.body.includes(`<!-- lumiverse-bundled:${request.sha}:${request.fingerprint} -->`)) {
    throw new Error("Keep build artifacts until the matching signed release is published");
  }
  const handoffs: Artifact[] = [];
  for (const builder of requestedBuilders(request)) {
    const run = await resolveBuilderRun(privateApi, request, builder);
    if (run.ready !== "true") throw new Error("Keep artifacts while a private builder is still running");
    const names = new Set([outputArtifactName(request, builder), ...(builder === "windows" ? [qualificationArtifactName(request)] : [])]);
    for (const artifact of await privateApi.artifacts(run.builder_run!)) {
      if (!names.has(artifact.name)) continue;
      handoffs.push(artifact);
    }
  }
  let bytes = 0;
  for (const artifact of handoffs) {
    await privateApi.deleteArtifact(artifact.id);
    bytes += artifact.size_in_bytes;
  }
  return { count: handoffs.length, bytes };
}
export async function resolveBuilderRun(api: BridgeAPI, request: LinuxReleaseRequest, builder: PrivateBuilder = "linux"): Promise<{ ready: string; builder_run?: string; builder_attempt?: string }> {
  for (let page = 1; ; page++) {
    const runs = await api.json<{ workflow_runs: Run[] }>(`/actions/workflows/${builder}-release.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`);
    const run = runs.workflow_runs.find(r => r.display_title === builderRunName(request, builder));
    if (run) {
      if (run.status !== "completed") return { ready: "false" };
      if (run.conclusion !== "success" || run.head_branch !== "main" || run.repository.full_name !== BUILDER_REPOSITORY
        || run.head_repository.full_name !== BUILDER_REPOSITORY || run.path !== workflowPath(builder)) {
        throw new Error(`Private ${builder} build did not complete successfully`);
      }
      return { ready: "true", builder_run: String(run.id), builder_attempt: String(run.run_attempt) };
    }
    if (runs.workflow_runs.length < 100) return { ready: "false" };
  }
}
export async function readRequest(api: BridgeAPI, runId: string, attempt: string): Promise<LinuxReleaseRequest> {
  if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(attempt)) throw new Error("Invalid source run identity");
  const artifacts = await api.artifacts(runId);
  const artifact = artifacts.find(a => a.name === `desktop-release-request-${attempt}`)
    || artifacts.find(a => a.name === `linux-release-request-${attempt}`);
  if (!artifact) throw new NoReleaseRequestError("Release request artifact is missing");
  if (artifact.expired || artifact.size_in_bytes > 128_000) throw new Error("Release request artifact is missing or invalid");
  const response = await api.response(`/actions/artifacts/${artifact.id}/zip`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 128_000) throw new Error("Release request archive exceeds size limit");
  const temporary = mkdtempSync(join(tmpdir(), "lumiverse-request-"));
  try {
    const archive = join(temporary, "request.zip"); writeFileSync(archive, bytes);
    const extracted = Bun.spawnSync(process.platform === "win32" ? ["tar", "-xOf", archive, "request.json"] : ["unzip", "-p", archive, "request.json"], { stdout: "pipe", stderr: "pipe" });
    if (extracted.exitCode !== 0 || extracted.stdout.length > 16_000) throw new Error("Invalid release request archive");
    const request = validateRequest(JSON.parse(extracted.stdout.toString()));
    if (request.run !== runId || request.attempt !== attempt) throw new Error("Release request run identity mismatch");
    validateParent(await api.json<Run>(`/actions/runs/${runId}`), request);
    return request;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
function output(values: Record<string, string>) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
}
// The controller on main may have a different fingerprint policy from staging.
// Validate the immutable SHA first, then evaluate that source's policy in a child
// without bridge tokens, GitHub credentials, signing keys or dotenv loading.
export function verifySource(source: string, request: LinuxReleaseRequest) {
  const environment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TEMP", "TMP"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: source, env: environment, stdout: "pipe", stderr: "pipe" });
  if (revision.exitCode !== 0 || revision.stdout.toString().trim() !== request.sha) throw new Error("Release source revision mismatch");
  const fingerprint = Bun.spawnSync([process.execPath, "--no-env-file", "-e", 'import {sourceFingerprint} from "./scripts/desktop-release.ts"; console.log(sourceFingerprint(process.cwd()));'],
    { cwd: source, env: environment, stdout: "pipe", stderr: "pipe" });
  if (fingerprint.exitCode !== 0 || fingerprint.stdout.toString().trim() !== request.fingerprint) throw new Error("Source fingerprint differs from the release request");
}
function verifyProvenance(metadata: Record<string, unknown>, request: LinuxReleaseRequest, label: string) {
  for (const key of ["format", "repository", "run", "attempt", "sha", "fingerprint", "version", "tag", "channel", "publicKey", "builders"] as const) {
    if (JSON.stringify(metadata[key]) !== JSON.stringify(request[key])) throw new Error(`${label} artifact provenance mismatch: ${key}`);
  }
}
export function verifyPayload(root: string, request: LinuxReleaseRequest, arch: keyof typeof LINUX_TARGETS) {
  const directory = join(root, arch);
  const metadata = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
  verifyProvenance(metadata, request, "Linux");
  if (metadata.arch !== arch || metadata.target !== LINUX_TARGETS[arch]) throw new Error("Linux artifact architecture mismatch");
  const manifest = JSON.parse(readFileSync(join(directory, "runtime-manifest.json"), "utf8"));
  if (manifest.architecture !== arch || manifest.revision !== request.sha) throw new Error("Native runtime provenance mismatch");
  const images = readdirSync(directory).filter(name => name.endsWith(".AppImage"));
  if (images.length !== 1 || !/^[A-Za-z0-9_. -]+\.AppImage$/.test(images[0]!)) throw new Error("Expected exactly one Linux AppImage");
  const path = join(directory, images[0]!);
  if (!lstatSync(path).isFile()) throw new Error("AppImage must be a regular file");
  const checksum = readFileSync(join(directory, "SHA256SUMS"), "utf8").trim();
  const expected = /^([a-f0-9]{64})  ([^\r\n/\\]+)$/.exec(checksum);
  if (!expected || expected[2] !== images[0] || createHash("sha256").update(readFileSync(path)).digest("hex") !== expected[1]) {
    throw new Error("Linux AppImage checksum mismatch");
  }
  return path;
}
export interface PrivateRunIdentity { run: string; attempt: string }
export function verifyWindowsPayload(root: string, request: LinuxReleaseRequest, arch: keyof typeof WINDOWS_TARGETS, builder: PrivateRunIdentity) {
  const directory = join(root, arch);
  const metadata = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
  verifyProvenance(metadata, request, "Windows");
  if (metadata.arch !== arch || metadata.target !== WINDOWS_TARGETS[arch]
    || metadata.builderRun !== builder.run || !/^[1-9]\d*$/.test(metadata.builderAttempt)
    || Number(metadata.builderAttempt) > Number(builder.attempt)) throw new Error("Windows artifact build identity mismatch");
  const build = JSON.parse(readFileSync(join(directory, "build.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(directory, "server-manifest.json"), "utf8"));
  if (build.source !== request.sha || build.version !== request.version || build.architecture !== arch
    || build.target !== WINDOWS_TARGETS[arch] || build.bunVersion !== "1.4.4" || build.signed !== false
    || build.serverSmokePassed !== (arch === "x64") || manifest.platform !== "win32" || manifest.arch !== arch
    || manifest.bunVersion !== "1.4.4" || !/^[a-f0-9]{64}$/.test(manifest.sha256) || build.serverSha256 !== manifest.sha256) {
    throw new Error("Windows server provenance mismatch");
  }
  const server = join(directory, `lumiverse-server-win32-${arch}.exe`);
  if (!lstatSync(server).isFile()) throw new Error("Windows server must be a regular file");
  const bytes = readFileSync(server), header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = bytes.length >= 64 && header.getUint16(0, true) === 0x5a4d ? header.getUint32(0x3c, true) : -1;
  if (offset < 0 || offset + 6 > bytes.length || header.getUint32(offset, true) !== 0x4550
    || header.getUint16(offset + 4, true) !== (arch === "arm64" ? 0xaa64 : 0x8664)
    || createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) throw new Error("Windows server integrity mismatch");
  const installers = readdirSync(directory).filter(name => name.endsWith("-setup.exe"));
  if (installers.length !== 1 || !/^[A-Za-z0-9_. -]+-setup\.exe$/.test(installers[0]!)) throw new Error("Expected exactly one Windows NSIS installer");
  const installer = join(directory, installers[0]!);
  if (!lstatSync(installer).isFile()) throw new Error("Windows installer must be a regular file");
  const checksum = /^([a-f0-9]{64})  ([^\r\n/\\]+)$/.exec(readFileSync(join(directory, "SHA256SUMS"), "utf8").trim());
  if (!checksum || checksum[2] !== installers[0] || checksum[1] !== build.sha256
    || createHash("sha256").update(readFileSync(installer)).digest("hex") !== checksum[1]) throw new Error("Windows installer checksum mismatch");
  return { installer, installerSha256: checksum[1], serverSha256: manifest.sha256 as string, builderAttempt: metadata.builderAttempt as string };
}
export function verifyWindowsQualification(file: string, request: LinuxReleaseRequest, builder: PrivateRunIdentity, payload: ReturnType<typeof verifyWindowsPayload>) {
  const qualification = JSON.parse(readFileSync(file, "utf8"));
  verifyProvenance(qualification, request, "Windows qualification");
  if (qualification.arch !== "arm64" || qualification.builderRun !== builder.run || qualification.builderAttempt !== payload.builderAttempt
    || qualification.qualificationAttempt !== builder.attempt
    || qualification.serverSha256 !== payload.serverSha256 || qualification.installerSha256 !== payload.installerSha256
    || qualification.serverSmokePassed !== true) throw new Error("Native Windows ARM64 qualification mismatch");
}
export function verifyMacOSPayload(root: string, request: LinuxReleaseRequest, builder: PrivateRunIdentity) {
  const directory = join(root, "x64");
  const metadata = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
  verifyProvenance(metadata, request, "macOS");
  if (metadata.arch !== "x64" || metadata.target !== MACOS_TARGET || metadata.builderRun !== builder.run
    || !/^[1-9]\d*$/.test(metadata.builderAttempt) || Number(metadata.builderAttempt) > Number(builder.attempt)) {
    throw new Error("macOS artifact build identity mismatch");
  }
  const build = JSON.parse(readFileSync(join(directory, "build.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(directory, "server-manifest.json"), "utf8"));
  if (build.source !== request.sha || build.version !== request.version || build.architecture !== "x64"
    || build.target !== MACOS_TARGET || build.bunVersion !== "1.4.4" || build.signed !== false
    || build.serverSmokePassed !== true || manifest.platform !== "darwin" || manifest.arch !== "x64"
    || manifest.bunVersion !== "1.4.4" || !/^[a-f0-9]{64}$/.test(manifest.sha256) || build.serverSha256 !== manifest.sha256) {
    throw new Error("macOS server provenance mismatch");
  }
  const checked = (name: string, expected: string) => {
    const path = join(directory, name);
    if (!lstatSync(path).isFile()) throw new Error(`macOS ${name} must be a regular file`);
    const bytes = readFileSync(path);
    if (!/^[a-f0-9]{64}$/.test(expected) || createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`macOS ${name} checksum mismatch`);
    return { path, bytes };
  };
  const archive = checked("Lumiverse.app.tar.gz", build.archiveSha256).path;
  const dmg = checked("Lumiverse.dmg", build.dmgSha256).path;
  if (typeof build.applicationName !== "string" || !/^[A-Za-z0-9_. -]+\.app$/.test(build.applicationName)
    || !/^[a-f0-9]{64}$/.test(build.bundledServerSha256) || !/^[a-f0-9]{64}$/.test(build.nativeSha256)
    || typeof build.nativePublished !== "boolean") throw new Error("Invalid macOS bundle metadata");
  const entry = `${build.applicationName}/Contents/MacOS/lumiverse-server`;
  const listing = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
  if (listing.exitCode !== 0 || listing.stdout.toString().split(/\r?\n/).filter(path => path === entry).length !== 1) {
    throw new Error("macOS application archive does not contain exactly one bundled server");
  }
  const extraction = Bun.spawnSync(["tar", "-xOzf", archive, entry], { stdout: "pipe", stderr: "pipe" });
  const server = Buffer.from(extraction.stdout);
  if (extraction.exitCode !== 0 || server.length < 32 || server.readUInt32LE(0) !== 0xfeedfacf
    || server.readUInt32LE(4) !== 0x01000007 || server.readUInt32LE(12) !== 2
    || createHash("sha256").update(server).digest("hex") !== build.bundledServerSha256) {
    throw new Error("Bundled macOS server integrity mismatch");
  }
  const native = build.nativePublished ? undefined : join(directory, "lancedb");
  if (native) for (const name of ["lancedb.darwin-x64.node", "manifest.json", "LICENSE"]) {
    if (!lstatSync(join(native, name)).isFile()) throw new Error("Native LanceDB handoff must contain regular files");
  }
  return { archive, dmg, native, nativeSha256: build.nativeSha256 as string };
}

// The source checkout owns its own LanceDB policy (main and staging can differ).
// Validate it in a child without credentials before accepting a private handoff.
export function verifyMacOSNative(source: string, directory: string): string {
  const environment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TEMP", "TMP"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  const code = 'import {readIntelLanceDbArtifact} from "./scripts/lancedb-macos-native.ts"; import {readFileSync} from "node:fs"; const pkg=JSON.parse(readFileSync("package.json","utf8")); console.log(readIntelLanceDbArtifact(process.argv.at(-1),pkg.dependencies["@lancedb/lancedb"]).sha256);';
  const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", code, directory], { cwd: source, env: environment, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Private macOS LanceDB handoff failed the source build policy");
  return result.stdout.toString().trim();
}
export async function resolvePrivateBuilds(api: BridgeAPI, request: LinuxReleaseRequest) {
  const results = await Promise.all(requestedBuilders(request).map(async builder => ({ builder, result: await resolveBuilderRun(api, request, builder) })));
  const values: Record<string, string> = { ready: results.every(({ result }) => result.ready === "true") ? "true" : "false", linux_ready: "false", windows_ready: "false", macos_ready: "false" };
  for (const { builder, result } of results) {
    values[`${builder}_ready`] = result.ready;
    if (result.builder_run) values[`${builder}_run`] = result.builder_run;
    if (result.builder_attempt) values[`${builder}_attempt`] = result.builder_attempt;
  }
  return values;
}
async function main() {
  const mode = process.argv[2];
  const publicApi = () => new BridgeAPI(process.env.GITHUB_TOKEN || process.env.LINUX_RELEASE_BRIDGE_TOKEN!, SOURCE_REPOSITORY);
  const requestFile = resolve(process.env.LINUX_RELEASE_REQUEST || "request.json");
  if (mode === "matrix") {
    output({ platforms: JSON.stringify(hostedReleasePlatforms(process.env.DESKTOP_CHANNEL!)) });
  } else if (mode === "request") {
    const request = validateRequest({ format: 3, repository: process.env.GITHUB_REPOSITORY,
      run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
      channel: process.env.DESKTOP_CHANNEL, version: process.env.DESKTOP_VERSION, tag: process.env.DESKTOP_TAG,
      sha: process.env.DESKTOP_SHA, fingerprint: process.env.DESKTOP_SOURCE, publicKey: process.env.LUMIVERSE_UPDATER_PUBLIC_KEY?.trim(),
      builders: process.env.DESKTOP_CHANNEL === "nightly" ? ["linux", "windows", "macos"] : ["windows", "macos"] });
    writeFileSync(requestFile, JSON.stringify(request, null, 2) + "\n");
  } else if (mode === "dispatch") {
    const builder = process.env.PRIVATE_BUILDER as PrivateBuilder;
    if (!PRIVATE_BUILDERS.includes(builder)) throw new Error("Choose a private release builder");
    await new BridgeAPI(process.env.LINUX_RELEASE_BRIDGE_TOKEN!, BUILDER_REPOSITORY).response(`/actions/workflows/${builder}-release.yml/dispatches`, {
      ref: "main", inputs: { source_run: process.env.GITHUB_RUN_ID, source_attempt: process.env.GITHUB_RUN_ATTEMPT },
    });
    console.log(`Queued ${builder} x64 and ARM64 builds in the private repository; no hosted runner waits for compilation.`);
  } else if (mode === "fetch" || mode === "resolve") {
    let request: LinuxReleaseRequest;
    try {
      request = await readRequest(publicApi(), process.env.SOURCE_RUN_ID!, process.env.SOURCE_RUN_ATTEMPT!);
    } catch (error) {
      // A nightly with unchanged source succeeds without requesting a build.
      // Manual callbacks and malformed/expired requests still fail closed.
      if (mode === "resolve" && process.env.GITHUB_EVENT_NAME === "workflow_run" && error instanceof NoReleaseRequestError) {
        output({ ready: "false" }); console.log("This workflow did not request a private release build."); return;
      }
      throw error;
    }
    if (mode === "fetch" && process.env.PRIVATE_BUILDER && !requestedBuilders(request).includes(process.env.PRIVATE_BUILDER as PrivateBuilder)) {
      throw new Error("This release did not request the selected private builder");
    }
    writeFileSync(requestFile, JSON.stringify(request, null, 2) + "\n");
    output({ source: request.sha, artifact: outputArtifactName(request), linux_artifact: outputArtifactName(request),
      windows_artifact: outputArtifactName(request, "windows"), windows_qualification: qualificationArtifactName(request),
      macos_artifact: outputArtifactName(request, "macos"), public_key: request.publicKey });
    if (mode === "resolve") {
      if (request.publicKey !== process.env.LUMIVERSE_UPDATER_PUBLIC_KEY?.trim()) throw new Error("Release public key has changed");
      const release = await new ReleaseAPI(SOURCE_REPOSITORY, process.env.GITHUB_TOKEN!).release(request.tag);
      if (release && !release.draft) {
        if (!release.body.includes(`<!-- lumiverse-bundled:${request.sha}:${request.fingerprint} -->`)) throw new Error("Published release source differs");
        // A duplicate callback may follow publication, or retry a failed feed
        // upload. Reuse the signed release without replacing its payloads.
        output({ ready: "false", published: "true" }); return;
      }
      const privateApi = new BridgeAPI(process.env.LINUX_RELEASE_BRIDGE_TOKEN!, BUILDER_REPOSITORY);
      const result = await resolvePrivateBuilds(privateApi, request);
      output(result);
      if (result.ready !== "true") console.log("A private release build is still queued or running.");
    }
  } else if (mode === "stage" || mode === "verify-source") {
    const request = validateRequest(JSON.parse(readFileSync(requestFile, "utf8")));
    const source = resolve(process.env.SOURCE_DIRECTORY || "source");
    verifySource(source, request);
    if (mode === "verify-source") return;
    const files: Array<{ file: string; target: string; folder: string }> = [];
    let macosNative: string | undefined;
    for (const builder of requestedBuilders(request)) {
      if (builder === "macos") {
        const identity = { run: process.env.PRIVATE_MACOS_RUN!, attempt: process.env.PRIVATE_MACOS_ATTEMPT! };
        if (!/^[1-9]\d*$/.test(identity.run) || !/^[1-9]\d*$/.test(identity.attempt)) throw new Error("Missing private macOS build identity");
        const payload = verifyMacOSPayload(resolve(process.env.MACOS_ARTIFACT_DIRECTORY || "macos-artifacts"), request, identity);
        const native = payload.native || join(source, "dist/native/lancedb-darwin-x64");
        if (verifyMacOSNative(source, native) !== payload.nativeSha256) throw new Error("Private macOS LanceDB checksum differs from the tested addon");
        files.push({ file: payload.archive, target: MACOS_TARGET, folder: "macos" }, { file: payload.dmg, target: MACOS_TARGET, folder: "dmg" });
        macosNative = payload.native;
        continue;
      }
      for (const arch of ["x64", "arm64"] as const) {
        if (builder === "linux") {
          files.push({ file: verifyPayload(resolve(process.env.LINUX_ARTIFACT_DIRECTORY || "linux-artifacts"), request, arch), target: LINUX_TARGETS[arch], folder: "appimage" });
        } else {
          const identity = { run: process.env.PRIVATE_WINDOWS_RUN!, attempt: process.env.PRIVATE_WINDOWS_ATTEMPT! };
          if (!/^[1-9]\d*$/.test(identity.run) || !/^[1-9]\d*$/.test(identity.attempt)) throw new Error("Missing private Windows build identity");
          const payload = verifyWindowsPayload(resolve(process.env.WINDOWS_ARTIFACT_DIRECTORY || "windows-artifacts"), request, arch, identity);
          if (arch === "arm64") verifyWindowsQualification(resolve(process.env.WINDOWS_QUALIFICATION || "windows-qualification/qualification.json"), request, identity, payload);
          files.push({ file: payload.installer, target: WINDOWS_TARGETS[arch], folder: "nsis" });
        }
      }
    }
    // Validate every architecture before making any payload available to signing.
    for (const { file, target, folder } of files) {
      const destination = join(source, "desktop/src-tauri/target", target, "release/bundle", folder);
      mkdirSync(destination, { recursive: true }); copyFileSync(file, join(destination, basename(file)));
    }
    if (macosNative) {
      const destination = join(source, "dist/native/lancedb-darwin-x64");
      mkdirSync(destination, { recursive: true });
      for (const name of ["lancedb.darwin-x64.node", "manifest.json", "LICENSE"]) copyFileSync(join(macosNative, name), join(destination, name));
    }
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV,
      Object.entries({ DESKTOP_CHANNEL: request.channel, DESKTOP_VERSION: request.version, DESKTOP_TAG: request.tag, DESKTOP_SHA: request.sha, DESKTOP_SOURCE: request.fingerprint }).map(([k, v]) => `${k}=${v}\n`).join(""));
  } else if (mode === "publish") {
    const request = validateRequest(JSON.parse(readFileSync(requestFile, "utf8")));
    const parent = await publicApi().json<Run>(`/actions/runs/${request.run}`);
    validateParent(parent, request);
    if (parent.status !== "completed") { console.log("Hosted builds have not finished; release remains a draft."); return; }
    if (parent.conclusion !== "success") throw new Error("Hosted release builds did not succeed");
    const builders = await resolvePrivateBuilds(new BridgeAPI(process.env.LINUX_RELEASE_BRIDGE_TOKEN!, BUILDER_REPOSITORY), request);
    if (builders.ready !== "true") { console.log("Private builds have not finished; release remains a draft."); return; }
    await publishDesktopRelease(new ReleaseAPI(SOURCE_REPOSITORY, process.env.GITHUB_TOKEN!), request);
    output({ published_tag: request.tag, published_channel: request.channel });
    // Cleanup is retryable and must never turn a published update into failure.
    try {
      const removed = await cleanupPublishedBuildArtifacts(
        new BridgeAPI(process.env.LINUX_RELEASE_BRIDGE_TOKEN!, BUILDER_REPOSITORY),
        new ReleaseAPI(SOURCE_REPOSITORY, process.env.GITHUB_TOKEN!), request);
      console.log(`Removed ${removed.count} published-build handoffs (${(removed.bytes / 1024 ** 3).toFixed(2)} GiB).`);
    } catch (error) { console.warn(`Could not clean published-build artifacts: ${error instanceof Error ? error.message : String(error)}`); }
  } else if (mode === "notify") {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
    const run = event.workflow_run as Run;
    const match = /^(Linux|Windows|macOS) release ([1-9]\d*)\.([1-9]\d*)$/.exec(run.display_title);
    const builder = match?.[1].toLowerCase() as PrivateBuilder;
    if (!match || run.event !== "workflow_dispatch" || run.head_branch !== "main" || run.path !== workflowPath(builder)
      || run.repository.full_name !== BUILDER_REPOSITORY || run.head_repository.full_name !== BUILDER_REPOSITORY) throw new Error("Invalid completed build identity");
    await new BridgeAPI(process.env.LINUX_RELEASE_BRIDGE_TOKEN!, SOURCE_REPOSITORY).response("/actions/workflows/desktop-linux-complete.yml/dispatches", {
      ref: "main", inputs: { source_run: match[2], source_attempt: match[3] },
    });
  } else throw new Error("Use matrix, request, dispatch, fetch, resolve, verify-source, stage, publish or notify");
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
