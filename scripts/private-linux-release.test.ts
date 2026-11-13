import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { ReleaseAPI, sourceFingerprint as controllerFingerprint } from "./desktop-release";
import { BridgeAPI, BUILDER_REPOSITORY, SOURCE_REPOSITORY, LINUX_TARGETS, WINDOWS_TARGETS, MACOS_TARGET, NoReleaseRequestError, builderRunName, cleanupPublishedBuildArtifacts, hostedReleasePlatforms, readRequest, requestedBuilders, resolveBuilderRun, resolvePrivateBuilds, validateParent, validateRequest, verifyMacOSPayload, verifyMacOSNative, verifyPayload, verifySource, verifyWindowsPayload, verifyWindowsQualification, type LinuxReleaseRequest } from "./private-linux-release";
import { INTEL_LANCEDB, intelLanceDbBuildId } from "./lancedb-macos-native";

const request: LinuxReleaseRequest = { format: 1, repository: SOURCE_REPOSITORY, channel: "nightly", run: "1234", attempt: "2",
  version: "0.3.2-nightly.20261016.1234", tag: "desktop-v0.3.2-nightly.20261016.1234",
  sha: "a".repeat(40), fingerprint: "b".repeat(64), publicKey: "c".repeat(80) };
const run = { id: 1234, run_attempt: 2, event: "workflow_dispatch", path: ".github/workflows/desktop-build.yml", head_branch: "staging",
  status: "in_progress", conclusion: null, display_title: "Nightly", repository: { full_name: SOURCE_REPOSITORY }, head_repository: { full_name: SOURCE_REPOSITORY } };
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("concurrent artifact cleanup tolerates already deleted handoffs but reports permission failures", async () => {
  let status = 404;
  const transport = (async (_input: RequestInfo | URL) => new Response(null, { status })) as typeof fetch;
  const api = new BridgeAPI("test", BUILDER_REPOSITORY, transport);
  await expect(api.deleteArtifact(42)).resolves.toBeUndefined();
  status = 403;
  await expect(api.deleteArtifact(42)).rejects.toThrow("403");
  await expect(api.deleteArtifact(-1)).rejects.toThrow("Invalid artifact identity");
});

test("published release cleanup removes only the exact handoff names from successful private runs", async () => {
  const desktopRequest: LinuxReleaseRequest = { ...request, format: 2, builders: ["linux", "windows"] };
  const deleted: string[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") { deleted.push(url.split("/").at(-1)!); return new Response(null, { status: 204 }); }
    if (url.includes("/releases/tags/")) return Response.json({ draft: false, body: `<!-- lumiverse-bundled:${request.sha}:${request.fingerprint} -->` });
    const builder = url.includes("linux-release.yml") ? "linux" : "windows";
    if (url.includes("/workflows/")) return Response.json({ workflow_runs: [{
      id: builder === "linux" ? 98 : 99, run_attempt: 1, event: "workflow_dispatch", display_title: builderRunName(request, builder),
      status: "completed", conclusion: "success", head_branch: "main", path: `.github/workflows/${builder}-release.yml`,
      repository: { full_name: BUILDER_REPOSITORY }, head_repository: { full_name: BUILDER_REPOSITORY },
    }] });
    if (url.includes("/runs/98/artifacts")) return Response.json({ artifacts: [
      { id: 1, name: "linux-release-1234-2", size_in_bytes: 10 }, { id: 4, name: "linux-release-1234-1", size_in_bytes: 10 },
      { id: 5, name: "unrelated", size_in_bytes: 10 },
    ] });
    if (url.includes("/runs/99/artifacts")) return Response.json({ artifacts: [
      { id: 2, name: "windows-release-1234-2", size_in_bytes: 20 }, { id: 3, name: "windows-qualification-1234-2", size_in_bytes: 1 },
    ] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  expect(await cleanupPublishedBuildArtifacts(new BridgeAPI("test", BUILDER_REPOSITORY, transport), new ReleaseAPI(SOURCE_REPOSITORY, "test", transport), desktopRequest))
    .toEqual({ count: 3, bytes: 31 });
  expect(deleted).toEqual(["1", "2", "3"]);
});

test.each([
  { draft: true, body: `<!-- lumiverse-bundled:${request.sha}:${request.fingerprint} -->` },
  { draft: false, body: "another source" },
])("cleanup preserves retry artifacts until the matching signed release is published ($draft)", async (release) => {
  const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") throw new Error("Must not delete");
    return Response.json(release);
  }) as typeof fetch;
  await expect(cleanupPublishedBuildArtifacts(new BridgeAPI("test", BUILDER_REPOSITORY, transport), new ReleaseAPI(SOURCE_REPOSITORY, "test", transport), request))
    .rejects.toThrow("until the matching signed release");
});

test("Intel macOS and Windows releases use private VMs; stable Linux stays hosted", () => {
  expect(hostedReleasePlatforms("nightly").map(p => p.platform)).toEqual(["darwin-aarch64"]);
  expect(hostedReleasePlatforms("stable").map(p => p.platform)).toEqual(["darwin-aarch64", "linux-x86_64", "linux-aarch64"]);
  expect(() => hostedReleasePlatforms("pull_request")).toThrow();
});
test("release requests reject mismatched versions, identities, keys and shell input", () => {
  expect(validateRequest(request)).toEqual(request);
  for (const change of [{ channel: "stable" }, { repository: "other/repo" }, { run: "1234;id" }, { attempt: "0" },
    { version: "0.3.2-nightly.20261016.9999" }, { tag: "different" }, { sha: "z".repeat(40) },
    { fingerprint: "0\nINJECTED=1" }, { publicKey: "key\nINJECTED=1" }]) {
    expect(() => validateRequest({ ...request, ...change })).toThrow();
  }
});
test("requests must originate from the same trusted workflow attempt, never PRs or forks", () => {
  expect(() => validateParent(run, request)).not.toThrow();
  for (const change of [{ event: "pull_request" }, { head_branch: "feature" }, { path: ".github/workflows/untrusted.yml" },
    { run_attempt: 1 }, { id: 5678 }, { head_repository: { full_name: "fork/Lumiverse" } }]) {
    expect(() => validateParent({ ...run, ...change }, request)).toThrow();
  }
});
test("request downloads validate the artifact and original run before returning build metadata", async () => {
  const archive = zipSync({ "request.json": strToU8(JSON.stringify(request)) });
  let expired = false;
  const transport = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/artifacts?")) return Response.json({ artifacts: [{ id: 42, name: "linux-release-request-2", expired, size_in_bytes: archive.length }] });
    if (url.endsWith("/42/zip")) return new Response(new Uint8Array(archive).buffer);
    if (url.endsWith("/runs/1234")) return Response.json(run);
    throw new Error("Unexpected request");
  }) as typeof fetch;
  const api = new BridgeAPI("test-token", SOURCE_REPOSITORY, transport);
  expect(await readRequest(api, "1234", "2")).toEqual(request);
  expired = true;
  await expect(readRequest(api, "1234", "2")).rejects.toThrow("missing or invalid");
  await expect(readRequest(api, "../1234", "2")).rejects.toThrow("Invalid source");
  const empty = new BridgeAPI("test-token", SOURCE_REPOSITORY, (async (_input: RequestInfo | URL) => Response.json({ artifacts: [] })) as typeof fetch);
  await expect(readRequest(empty, "1234", "2")).rejects.toBeInstanceOf(NoReleaseRequestError);
});
test("completion joins only the matching successful private run and waits without polling", async () => {
  const completed = { ...run, id: 99, display_title: builderRunName(request), status: "completed", conclusion: "success",
    head_branch: "main", path: ".github/workflows/linux-release.yml", repository: { full_name: BUILDER_REPOSITORY }, head_repository: { full_name: BUILDER_REPOSITORY } };
  let runs = [completed];
  const api = new BridgeAPI("test-token", BUILDER_REPOSITORY, (async (_input: RequestInfo | URL) => Response.json({ workflow_runs: runs })) as typeof fetch);
  expect(await resolveBuilderRun(api, request)).toEqual({ ready: "true", builder_run: "99", builder_attempt: "2" });
  for (const change of [{ status: "in_progress" }, { status: "queued" }, { display_title: "Linux release 1234.1" }]) {
    runs = [{ ...completed, ...change }];
    expect(await resolveBuilderRun(api, request)).toEqual({ ready: "false" });
  }
  for (const change of [{ conclusion: "failure" }, { conclusion: "cancelled" }, { head_branch: "other" },
    { path: ".github/workflows/other.yml" }, { head_repository: { full_name: "other/repo" } }]) {
    runs = [{ ...completed, ...change }];
    await expect(resolveBuilderRun(api, request)).rejects.toThrow("did not complete successfully");
  }
});
function payload() {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-linux-release-test-")); temporary.push(root);
  const directory = join(root, "arm64"); mkdirSync(directory);
  const image = join(directory, "Lumiverse.AppImage"); writeFileSync(image, "finalized payload");
  const checksum = createHash("sha256").update("finalized payload").digest("hex");
  writeFileSync(join(directory, "SHA256SUMS"), `${checksum}  Lumiverse.AppImage\n`);
  writeFileSync(join(directory, "release.json"), JSON.stringify({ ...request, arch: "arm64", target: LINUX_TARGETS.arm64 }));
  writeFileSync(join(directory, "runtime-manifest.json"), JSON.stringify({ architecture: "arm64", revision: request.sha }));
  return { root, directory, image };
}
test("payload verification binds exact bytes, version, runtime and architecture to the original request", () => {
  const f = payload(); expect(verifyPayload(f.root, request, "arm64")).toBe(f.image);
  writeFileSync(f.image, "modified payload"); expect(() => verifyPayload(f.root, request, "arm64")).toThrow("checksum");
  writeFileSync(f.image, "finalized payload");
  expect(() => verifyPayload(f.root, { ...request, version: "different" }, "arm64")).toThrow("provenance");
  writeFileSync(join(f.directory, "runtime-manifest.json"), JSON.stringify({ architecture: "x64", revision: request.sha }));
  expect(() => verifyPayload(f.root, request, "arm64")).toThrow("Native runtime");
});
test("payload verification rejects symlinks and checksum paths outside the artifact", () => {
  const f = payload();
  writeFileSync(join(f.directory, "SHA256SUMS"), "a".repeat(64) + "  ../outside.AppImage\n");
  expect(() => verifyPayload(f.root, request, "arm64")).toThrow("checksum");
  if (process.platform !== "win32") {
    rmSync(f.image); symlinkSync(join(f.directory, "release.json"), f.image);
    expect(() => verifyPayload(f.root, request, "arm64")).toThrow("regular file");
  }
});

const desktopRequest: LinuxReleaseRequest = { ...request, format: 2, builders: ["linux", "windows"] };
const identity = { run: "99", attempt: "3" };
test("version 3 requests include macOS while older in-flight requests remain valid", () => {
  const nightly: LinuxReleaseRequest = { ...request, format: 3, builders: ["linux", "windows", "macos"] };
  const stable: LinuxReleaseRequest = { ...nightly, channel: "stable", version: "0.3.1", tag: "desktop-v0.3.1", builders: ["windows", "macos"] };
  expect(validateRequest(nightly)).toEqual(nightly);
  expect(validateRequest(stable)).toEqual(stable);
  expect(validateRequest(desktopRequest)).toEqual(desktopRequest);
  expect(() => validateRequest({ ...nightly, builders: ["linux", "windows"] })).toThrow();
  expect(() => validateRequest({ ...stable, builders: ["macos"] })).toThrow();
  expect(builderRunName(nightly, "macos")).toBe("macOS release 1234.2");
});
test("new requests specify all private builders and support trusted stable releases", () => {
  expect(requestedBuilders(validateRequest(desktopRequest))).toEqual(["linux", "windows"]);
  expect(requestedBuilders(request)).toEqual(["linux"]);
  const stable: LinuxReleaseRequest = { ...desktopRequest, channel: "stable", version: "0.3.1", tag: "desktop-v0.3.1", builders: ["windows"] };
  expect(validateRequest(stable)).toEqual(stable);
  expect(() => validateParent({ ...run, path: ".github/workflows/desktop-release.yml", head_branch: "main" }, stable)).not.toThrow();
  expect(() => validateParent({ ...run, path: ".github/workflows/desktop-release.yml", event: "push", head_branch: stable.tag }, stable)).not.toThrow();
  expect(() => validateParent(run, stable)).toThrow("trusted desktop");
  expect(() => validateParent({ ...run, path: ".github/workflows/desktop-release.yml", head_branch: "staging" }, stable)).toThrow();
  for (const builders of [[], ["windows"], ["linux"], ["linux", "windows", "windows"], ["other"]]) {
    expect(() => validateRequest({ ...desktopRequest, builders })).toThrow();
  }
  expect(() => validateRequest({ ...stable, builders: ["linux", "windows"] })).toThrow();
});
test("the release joins both builders in either order and fails when either builder fails", async () => {
  const completed = (builder: "linux" | "windows") => ({ ...run, id: builder === "linux" ? 98 : 99, run_attempt: 3,
    display_title: builderRunName(desktopRequest, builder), status: "completed", conclusion: "success", head_branch: "main",
    path: `.github/workflows/${builder}-release.yml`, repository: { full_name: BUILDER_REPOSITORY }, head_repository: { full_name: BUILDER_REPOSITORY } });
  const runs = { linux: completed("linux"), windows: completed("windows") };
  const api = new BridgeAPI("test-token", BUILDER_REPOSITORY, (async (input: RequestInfo | URL) => {
    const builder = String(input).includes("windows-release") ? "windows" : "linux";
    return Response.json({ workflow_runs: [runs[builder]] });
  }) as typeof fetch);
  for (const builder of ["linux", "windows"] as const) {
    runs[builder].status = "in_progress";
    expect((await resolvePrivateBuilds(api, desktopRequest)).ready).toBe("false");
    runs[builder].status = "completed";
  }
  expect(await resolvePrivateBuilds(api, desktopRequest)).toMatchObject({ ready: "true", linux_run: "98", windows_run: "99", windows_attempt: "3" });
  runs.linux.status = "queued"; runs.windows.conclusion = "failure";
  await expect(resolvePrivateBuilds(api, desktopRequest)).rejects.toThrow("Private windows build");
  runs.windows.conclusion = "success";
  expect(await resolvePrivateBuilds(api, { ...desktopRequest, channel: "stable", builders: ["windows"] })).toMatchObject({ ready: "true", linux_ready: "false", windows_ready: "true" });
});
test("version 3 completion waits for the correct Intel macOS build and rejects a failed run", async () => {
  const requested: LinuxReleaseRequest = { ...desktopRequest, format: 3, builders: ["linux", "windows", "macos"] };
  const runs = Object.fromEntries((["linux", "windows", "macos"] as const).map((builder, index) => [builder, {
    ...run, id: 100 + index, run_attempt: 2, display_title: builderRunName(requested, builder), status: "completed", conclusion: "success",
    head_branch: "main", path: `.github/workflows/${builder}-release.yml`, repository: { full_name: BUILDER_REPOSITORY }, head_repository: { full_name: BUILDER_REPOSITORY },
  }]));
  const api = new BridgeAPI("test-token", BUILDER_REPOSITORY, (async (input: RequestInfo | URL) => {
    const match = /workflows\/(linux|windows|macos)-release\.yml/.exec(String(input));
    return Response.json({ workflow_runs: [runs[match![1]!]] });
  }) as typeof fetch);
  runs.macos.status = "in_progress";
  expect((await resolvePrivateBuilds(api, requested)).ready).toBe("false");
  runs.macos.status = "completed";
  expect(await resolvePrivateBuilds(api, requested)).toMatchObject({ ready: "true", macos_ready: "true", macos_run: "102", macos_attempt: "2" });
  runs.macos.conclusion = "failure";
  await expect(resolvePrivateBuilds(api, requested)).rejects.toThrow("Private macos build");
});
function windowsPayload(arch: "x64" | "arm64" = "arm64", releaseRequest = desktopRequest, root?: string) {
  root ||= mkdtempSync(join(tmpdir(), "lumiverse-windows-release-"));
  if (!temporary.includes(root)) temporary.push(root);
  const directory = join(root, arch); mkdirSync(directory);
  const server = Buffer.alloc(128); server.writeUInt16LE(0x5a4d, 0); server.writeUInt32LE(64, 0x3c);
  server.writeUInt32LE(0x4550, 64); server.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 68);
  const serverSha256 = createHash("sha256").update(server).digest("hex");
  const installer = join(directory, "Lumiverse-setup.exe"), installerSha256 = createHash("sha256").update("finalized installer").digest("hex");
  writeFileSync(installer, "finalized installer"); writeFileSync(join(directory, `lumiverse-server-win32-${arch}.exe`), server);
  writeFileSync(join(directory, "SHA256SUMS"), `${installerSha256}  Lumiverse-setup.exe\n`);
  writeFileSync(join(directory, "release.json"), JSON.stringify({ ...releaseRequest, arch, target: WINDOWS_TARGETS[arch], builderRun: identity.run, builderAttempt: identity.attempt }));
  writeFileSync(join(directory, "server-manifest.json"), JSON.stringify({ platform: "win32", arch, bunVersion: "1.4.4", sha256: serverSha256 }));
  writeFileSync(join(directory, "build.json"), JSON.stringify({ source: releaseRequest.sha, version: releaseRequest.version, architecture: arch,
    target: WINDOWS_TARGETS[arch], bunVersion: "1.4.4", signed: false, serverSmokePassed: arch === "x64", sha256: installerSha256, serverSha256 }));
  return { root, directory, installer, serverSha256, installerSha256 };
}
test("Windows signing accepts only the requested source, architecture, build attempt and exact installer bytes", () => {
  for (const arch of ["x64", "arm64"] as const) {
    const f = windowsPayload(arch);
    expect(verifyWindowsPayload(f.root, desktopRequest, arch, identity).installer).toBe(f.installer);
    expect(() => verifyWindowsPayload(f.root, { ...desktopRequest, sha: "d".repeat(40) }, arch, identity)).toThrow("provenance");
    expect(() => verifyWindowsPayload(f.root, desktopRequest, arch, { ...identity, attempt: "2" })).toThrow("identity");
    writeFileSync(f.installer, "different installer");
    expect(() => verifyWindowsPayload(f.root, desktopRequest, arch, identity)).toThrow("checksum");
    writeFileSync(f.installer, "finalized installer");
    writeFileSync(join(f.directory, `lumiverse-server-win32-${arch}.exe`), "wrong server");
    expect(() => verifyWindowsPayload(f.root, desktopRequest, arch, identity)).toThrow("integrity");
  }
});
test("Windows signing requires native ARM64 smoke bound to the server, installer and private run attempt", () => {
  const f = windowsPayload(), payload = verifyWindowsPayload(f.root, desktopRequest, "arm64", identity);
  const file = join(f.root, "qualification.json");
  const qualified = { ...desktopRequest, arch: "arm64", builderRun: identity.run, builderAttempt: identity.attempt,
    qualificationAttempt: identity.attempt, serverSha256: f.serverSha256, installerSha256: f.installerSha256, serverSmokePassed: true };
  writeFileSync(file, JSON.stringify(qualified));
  expect(() => verifyWindowsQualification(file, desktopRequest, identity, payload)).not.toThrow();
  for (const changed of [{ serverSmokePassed: false }, { builderAttempt: "2" }, { qualificationAttempt: "2" }, { installerSha256: "a".repeat(64) }, { serverSha256: "a".repeat(64) }, { arch: "x64" }, { sha: "a-different-commit" }]) {
    writeFileSync(file, JSON.stringify({ ...qualified, ...changed }));
    expect(() => verifyWindowsQualification(file, desktopRequest, identity, payload)).toThrow();
  }
  const retry = { ...identity, attempt: "4" };
  const retried = verifyWindowsPayload(f.root, desktopRequest, "arm64", retry);
  writeFileSync(file, JSON.stringify(qualified));
  expect(() => verifyWindowsQualification(file, desktopRequest, retry, retried)).toThrow();
  writeFileSync(file, JSON.stringify({ ...qualified, qualificationAttempt: "4" }));
  expect(() => verifyWindowsQualification(file, desktopRequest, retry, retried)).not.toThrow();
});
test("Windows artifact downloads cannot substitute symlinks or checksum paths outside the artifact", () => {
  const f = windowsPayload();
  writeFileSync(join(f.directory, "SHA256SUMS"), `${f.installerSha256}  ../Lumiverse-setup.exe\n`);
  expect(() => verifyWindowsPayload(f.root, desktopRequest, "arm64", identity)).toThrow("checksum");
  if (process.platform !== "win32") {
    rmSync(f.installer); symlinkSync(join(f.directory, "build.json"), f.installer);
    expect(() => verifyWindowsPayload(f.root, desktopRequest, "arm64", identity)).toThrow("regular file");
  }
});

function macOSPayload(macRequest: LinuxReleaseRequest = { ...desktopRequest, format: 3, builders: ["linux", "windows", "macos"] }) {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-macos-release-")); temporary.push(root);
  const directory = join(root, "x64"), native = join(directory, "lancedb"); mkdirSync(native, { recursive: true });
  const server = Buffer.alloc(32); server.writeUInt32LE(0xfeedfacf, 0); server.writeUInt32LE(0x01000007, 4); server.writeUInt32LE(2, 12);
  const nativeBytes = Buffer.alloc(56); nativeBytes.writeUInt32LE(0xfeedfacf, 0); nativeBytes.writeUInt32LE(0x01000007, 4);
  nativeBytes.writeUInt32LE(3, 8); nativeBytes.writeUInt32LE(6, 12); nativeBytes.writeUInt32LE(1, 16);
  nativeBytes.writeUInt32LE(0x32, 32); nativeBytes.writeUInt32LE(24, 36); nativeBytes.writeUInt32LE(1, 40); nativeBytes.writeUInt32LE(13 << 16, 44);
  const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
  const app = join(root, "Lumiverse Desktop.app/Contents/MacOS"); mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "lumiverse-server"), server);
  const archive = join(directory, "Lumiverse.app.tar.gz");
  const tar = Bun.spawnSync(["tar", "-czf", archive, "Lumiverse Desktop.app"], { cwd: root, stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  writeFileSync(join(directory, "Lumiverse.dmg"), "installer");
  writeFileSync(join(directory, "release.json"), JSON.stringify({ ...macRequest, arch: "x64", target: MACOS_TARGET, builderRun: identity.run, builderAttempt: identity.attempt }));
  writeFileSync(join(directory, "server-manifest.json"), JSON.stringify({ platform: "darwin", arch: "x64", bunVersion: "1.4.4", sha256: hash(server) }));
  writeFileSync(join(directory, "build.json"), JSON.stringify({ source: macRequest.sha, version: macRequest.version, architecture: "x64", target: MACOS_TARGET,
    bunVersion: "1.4.4", signed: false, serverSmokePassed: true, serverSha256: hash(server), archiveSha256: hash(readFileSync(archive)), dmgSha256: hash("installer"),
    applicationName: "Lumiverse Desktop.app", bundledServerSha256: hash(server), nativeSha256: hash(nativeBytes), nativePublished: false }));
  writeFileSync(join(native, "lancedb.darwin-x64.node"), nativeBytes);
  writeFileSync(join(native, "LICENSE"), "license");
  writeFileSync(join(native, "manifest.json"), JSON.stringify({ ...INTEL_LANCEDB, format: 1, buildId: intelLanceDbBuildId(), sha256: hash(nativeBytes) }));
  return { root, directory, native, macRequest };
}
test.each(["\n", "\r\n"])("macOS handoff validates exact server entries with line ending %j", (lineEnding) => {
  const f = macOSPayload();
  const archive = join(f.directory, "Lumiverse.app.tar.gz");
  const listing = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
  expect(listing.exitCode).toBe(0);
  const entry = "Lumiverse Desktop.app/Contents/MacOS/lumiverse-server";
  const tar = spyOn(Bun, "spawnSync").mockReturnValueOnce({
    ...listing, stdout: Buffer.from(listing.stdout.toString().replace(/\r?\n/g, lineEnding)),
  });
  try {
    // Keep extraction real so only the textual listing changes, never server bytes.
    expect(verifyMacOSPayload(f.root, f.macRequest, identity).archive).toBe(archive);
    expect(tar).toHaveBeenCalledTimes(2);
    for (const entries of [[entry, entry], [`${entry}.bak`]]) {
      tar.mockReturnValueOnce({ ...listing, stdout: Buffer.from(entries.join(lineEnding) + lineEnding) });
      expect(() => verifyMacOSPayload(f.root, f.macRequest, identity)).toThrow("exactly one bundled server");
    }
  } finally { tar.mockRestore(); }
});
test("macOS handoff binds native server, installer and updater bytes to the requested run", () => {
  const f = macOSPayload();
  const payload = verifyMacOSPayload(f.root, f.macRequest, identity);
  expect(payload.archive).toBe(join(f.directory, "Lumiverse.app.tar.gz"));
  verifyMacOSNative(join(import.meta.dir, ".."), f.native);
  expect(() => verifyMacOSPayload(f.root, { ...f.macRequest, sha: "d".repeat(40) }, identity)).toThrow("provenance");
  expect(() => verifyMacOSPayload(f.root, f.macRequest, { ...identity, attempt: "2" })).toThrow("identity");
  writeFileSync(payload.dmg, "changed");
  expect(() => verifyMacOSPayload(f.root, f.macRequest, identity)).toThrow("checksum");
  writeFileSync(join(f.native, "lancedb.darwin-x64.node"), "changed");
  expect(() => verifyMacOSNative(join(import.meta.dir, ".."), f.native)).toThrow("source build policy");
});
test("macOS handoff verifies the server inside the app even when the archive checksum is updated", () => {
  const f = macOSPayload();
  writeFileSync(join(f.root, "Lumiverse Desktop.app/Contents/MacOS/lumiverse-server"), "modified server");
  const archive = join(f.directory, "Lumiverse.app.tar.gz");
  const tar = Bun.spawnSync(["tar", "-czf", archive, "Lumiverse Desktop.app"], { cwd: f.root, stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  const buildFile = join(f.directory, "build.json"), build = JSON.parse(readFileSync(buildFile, "utf8"));
  build.archiveSha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(buildFile, JSON.stringify(build));
  expect(() => verifyMacOSPayload(f.root, f.macRequest, identity)).toThrow("Bundled macOS server integrity");
});
test("main verifies staging using the immutable source policy without passing credentials or loading dotenv", async () => {
  const source = mkdtempSync(join(tmpdir(), "lumiverse-staging-policy-")); temporary.push(source);
  mkdirSync(join(source, "scripts"));
  writeFileSync(join(source, "scripts/desktop-release.ts"), readFileSync(join(import.meta.dir, "desktop-release.ts"), "utf8")
    .replace('"scripts/build-lancedb-macos.ts"', '"scripts/source-only-policy.ts"')
    + '\nif (process.env.GITHUB_TOKEN || process.env.LINUX_RELEASE_BRIDGE_TOKEN || process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error("Credentials passed to source policy");\n');
  writeFileSync(join(source, "scripts/source-only-policy.ts"), "new source policy input");
  writeFileSync(join(source, ".env"), "GITHUB_TOKEN=must-not-load-dotenv\n");
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", "-c", "user.name=Release Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: source, env: { ...process.env, GIT_CONFIG_GLOBAL: join(source, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  git("init"); git("add", "."); git("commit", "-m", "Staging policy fixture");
  const policy = await import(join(source, "scripts/desktop-release.ts"));
  const immutable = { ...desktopRequest, sha: git("rev-parse", "HEAD"), fingerprint: policy.sourceFingerprint(source) };
  expect(immutable.fingerprint).not.toBe(controllerFingerprint(source));
  const keys = ["GITHUB_TOKEN", "LINUX_RELEASE_BRIDGE_TOKEN", "TAURI_SIGNING_PRIVATE_KEY"];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "must-not-pass-to-source-policy";
    expect(() => verifySource(source, immutable)).not.toThrow();
    expect(() => verifySource(source, { ...immutable, fingerprint: controllerFingerprint(source) })).toThrow("fingerprint");
    expect(() => verifySource(source, { ...immutable, sha: "d".repeat(40) })).toThrow("revision");
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
}, 60_000);

test("version 3 stages Intel macOS only after all private payloads and native policy verify", () => {
  const source = mkdtempSync(join(tmpdir(), "lumiverse-macos-stage-")); temporary.push(source);
  mkdirSync(join(source, "scripts"));
  writeFileSync(join(source, "scripts/desktop-release.ts"), `export function sourceFingerprint() { return "${request.fingerprint}"; }`);
  writeFileSync(join(source, "scripts/lancedb-macos-native.ts"), readFileSync(join(import.meta.dir, "lancedb-macos-native.ts")));
  writeFileSync(join(source, "package.json"), JSON.stringify({ dependencies: { "@lancedb/lancedb": INTEL_LANCEDB.version } }));
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", "-c", "user.name=Release Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: source, env: { ...process.env, GIT_CONFIG_GLOBAL: join(source, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  git("init"); git("add", "."); git("commit", "-m", "Immutable source fixture");
  const stable: LinuxReleaseRequest = { ...desktopRequest, format: 3, channel: "stable", version: "0.3.1", tag: "desktop-v0.3.1",
    sha: git("rev-parse", "HEAD"), builders: ["windows", "macos"] };
  const requestFile = join(source, "request.json"); writeFileSync(requestFile, JSON.stringify(stable));
  const x64 = windowsPayload("x64", stable), arm64 = windowsPayload("arm64", stable, x64.root), mac = macOSPayload(stable);
  const qualification = join(source, "qualification.json");
  writeFileSync(qualification, JSON.stringify({ ...stable, arch: "arm64", builderRun: identity.run, builderAttempt: identity.attempt,
    qualificationAttempt: identity.attempt, installerSha256: arm64.installerSha256, serverSha256: arm64.serverSha256, serverSmokePassed: true }));
  const env = { ...process.env, LINUX_RELEASE_REQUEST: requestFile, SOURCE_DIRECTORY: source, GITHUB_ENV: join(source, "release.env"),
    PRIVATE_WINDOWS_RUN: identity.run, PRIVATE_WINDOWS_ATTEMPT: identity.attempt, WINDOWS_ARTIFACT_DIRECTORY: x64.root, WINDOWS_QUALIFICATION: qualification,
    PRIVATE_MACOS_RUN: identity.run, PRIVATE_MACOS_ATTEMPT: identity.attempt, MACOS_ARTIFACT_DIRECTORY: mac.root };
  const stage = () => Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "private-linux-release.ts"), "stage"], { cwd: source, env, stdout: "pipe", stderr: "pipe" });
  const binary = join(mac.native, "lancedb.darwin-x64.node");
  const original = readFileSync(binary); writeFileSync(binary, "corrupted");
  expect(stage().exitCode).toBe(1);
  expect(existsSync(join(source, "desktop/src-tauri/target"))).toBe(false);
  writeFileSync(binary, original);
  const result = stage(); expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0);
  expect(readFileSync(join(source, `desktop/src-tauri/target/${MACOS_TARGET}/release/bundle/macos/Lumiverse.app.tar.gz`))).toEqual(readFileSync(join(mac.directory, "Lumiverse.app.tar.gz")));
  expect(readFileSync(join(source, `desktop/src-tauri/target/${MACOS_TARGET}/release/bundle/dmg/Lumiverse.dmg`), "utf8")).toBe("installer");
  expect(readFileSync(join(source, "dist/native/lancedb-darwin-x64/lancedb.darwin-x64.node"))).toEqual(original);
  const buildFile = join(mac.directory, "build.json"), build = JSON.parse(readFileSync(buildFile, "utf8"));
  writeFileSync(buildFile, JSON.stringify({ ...build, nativePublished: true }));
  rmSync(mac.native, { recursive: true });
  expect(stage().exitCode).toBe(0);
  writeFileSync(join(source, "dist/native/lancedb-darwin-x64/lancedb.darwin-x64.node"), "corrupted");
  expect(stage().exitCode).toBe(1);
}, 60_000);

test("the release CLI creates stable Windows requests and stages nothing until native qualification passes", () => {
  const source = mkdtempSync(join(tmpdir(), "lumiverse-windows-stage-")); temporary.push(source);
  mkdirSync(join(source, "scripts"));
  writeFileSync(join(source, "scripts/desktop-release.ts"), `export function sourceFingerprint() { return "${request.fingerprint}"; }`);
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", "-c", "user.name=Release Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: source, env: { ...process.env, GIT_CONFIG_GLOBAL: join(source, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  git("init"); git("add", "."); git("commit", "-m", "Immutable source fixture");
  const requestFile = join(source, "request.json");
  const env = { ...process.env, LINUX_RELEASE_REQUEST: requestFile, GITHUB_REPOSITORY: SOURCE_REPOSITORY,
    GITHUB_RUN_ID: request.run, GITHUB_RUN_ATTEMPT: request.attempt, DESKTOP_CHANNEL: "stable", DESKTOP_VERSION: "0.3.1",
    DESKTOP_TAG: "desktop-v0.3.1", DESKTOP_SHA: git("rev-parse", "HEAD"), DESKTOP_SOURCE: request.fingerprint, LUMIVERSE_UPDATER_PUBLIC_KEY: request.publicKey,
    SOURCE_DIRECTORY: source, PRIVATE_WINDOWS_RUN: identity.run, PRIVATE_WINDOWS_ATTEMPT: identity.attempt,
    GITHUB_ENV: join(source, "release.env"), WINDOWS_ARTIFACT_DIRECTORY: "", WINDOWS_QUALIFICATION: join(source, "qualification.json") };
  const cli = (mode: string) => Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "private-linux-release.ts"), mode], { cwd: source, env, stdout: "pipe", stderr: "pipe" });
  expect(cli("request").exitCode).toBe(0);
  const newStable = validateRequest(JSON.parse(readFileSync(requestFile, "utf8")));
  expect(newStable).toMatchObject({ format: 3, channel: "stable", builders: ["windows", "macos"] });
  // Also preserve completion of in-flight version 2 requests.
  const stable: LinuxReleaseRequest = { ...newStable, format: 2, builders: ["windows"] };
  writeFileSync(requestFile, JSON.stringify(stable));
  const x64 = windowsPayload("x64", stable), arm64 = windowsPayload("arm64", stable, x64.root);
  env.WINDOWS_ARTIFACT_DIRECTORY = x64.root;
  const refused = cli("stage"); expect(refused.exitCode).toBe(1);
  expect(existsSync(join(source, "desktop/src-tauri/target"))).toBe(false);
  expect(existsSync(env.GITHUB_ENV)).toBe(false);
  writeFileSync(env.WINDOWS_QUALIFICATION, JSON.stringify({ ...stable, arch: "arm64", builderRun: identity.run, builderAttempt: identity.attempt,
    qualificationAttempt: identity.attempt, installerSha256: arm64.installerSha256, serverSha256: arm64.serverSha256, serverSmokePassed: true }));
  const staged = cli("stage"); expect(staged.stderr.toString()).toBe(""); expect(staged.exitCode).toBe(0);
  for (const target of Object.values(WINDOWS_TARGETS)) {
    expect(readFileSync(join(source, "desktop/src-tauri/target", target, "release/bundle/nsis/Lumiverse-setup.exe"), "utf8")).toBe("finalized installer");
  }
  expect(readFileSync(env.GITHUB_ENV, "utf8")).toContain("DESKTOP_CHANNEL=stable\n");
}, 60_000);
