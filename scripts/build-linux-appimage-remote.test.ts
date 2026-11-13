import { expect, test } from "bun:test";
import { diagnosticVersion, includeSnapshotPath, parseOptions, shellQuote } from "./build-linux-appimage-remote";

test("remote builds accept SSH profiles and bounded parallelism", () => {
  expect(parseOptions(["builder@build-host.example", "--jobs", "12"]).jobs).toBe(12);
  expect(parseOptions(["linux-builder"]).host).toBe("linux-builder");
  for (const args of [["--bad-host"], ["user@host;touch /tmp/injected"], ["host", "--jobs", "0"], ["host", "--jobs", "65"], ["host", "--unknown", "value"]]) {
    expect(() => parseOptions(args)).toThrow();
  }
});

test("build architecture is explicit and limited to supported Linux runtimes", () => {
  expect(parseOptions(["server"]).arch).toBe("x64");
  expect(parseOptions(["server", "--arch", "arm64"]).arch).toBe("arm64");
  expect(parseOptions(["--local", "--arch", "arm64"]).arch).toBe("arm64");
  for (const arch of ["arm", "aarch64", "amd64", "../x64", "arm64;id"]) {
    expect(() => parseOptions(["server", "--arch", arch])).toThrow();
  }
  expect(() => parseOptions(["server", "--arch"])).toThrow();
});

test("architecture build IDs produce valid diagnostic versions, including numeric hashes", () => {
  const version = diagnosticVersion("0.3.1", "20261016T232740Z-arm64-0000000001");
  expect(version).toBe("0.3.1-diagnostic.20261016T232740Z.arm64.s0000000001");
  expect(version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/);
  expect(Bun.semver.order(version, "0.3.1")).toBe(-1);
  expect(diagnosticVersion("0.3.1-beta.2", "20261016T232740Z-x64-aabbccddee"))
    .toBe("0.3.1-diagnostic.20261016T232740Z.x64.saabbccddee");
  expect(diagnosticVersion("0.3.1", "20261016T232740Z-aabbccddee"))
    .toBe("0.3.1-diagnostic.20261016T232740Z.saabbccddee");
  expect(() => diagnosticVersion("0.3.1", "malformed-build-id")).toThrow();
});

test("native cross-compilation is opt-in and requires the ARM64 target", () => {
  expect(parseOptions(["server"]).cross).toBe(false);
  expect(parseOptions(["server", "--arch", "arm64", "--cross"]).cross).toBe(true);
  expect(parseOptions(["--local", "--cross", "--arch", "arm64"]).cross).toBe(true);
  expect(() => parseOptions(["server", "--cross"])).toThrow("--arch arm64");
  expect(() => parseOptions(["--local", "--arch", "x64", "--cross"])).toThrow("--arch arm64");
});

test("headless builds can publish to a server share without downloading or GUI smoke", () => {
  const options = parseOptions(["builder@build-host.example", "--remote-output", "/srv/build-output", "--no-download"]);
  expect(options.remoteOutput).toBe("/srv/build-output");
  expect(options.download).toBe(false);
  expect(options.smoke).toBe(false);
  expect(parseOptions(["server", "--smoke"]).smoke).toBe(true);
  expect(() => parseOptions(["server", "--remote-output", "relative/path"])).toThrow();
});

test("local Linux mode accepts an output directory and excludes remote-only options", () => {
  const options = parseOptions(["--local", "--output", "/srv/build-output", "--jobs", "8"]);
  expect(options.local).toBe(true);
  expect(options.host).toBeUndefined();
  expect(options.output).toBe("/srv/build-output");
  expect(options.jobs).toBe(8);
  for (const args of [["server", "--local"], ["--local", "--remote-output", "/share"], ["--local", "--no-download"], []]) {
    expect(() => parseOptions(args)).toThrow();
  }
});

test("diagnostic snapshots exclude credentials, instance data and generated binaries", () => {
  for (const path of [".env", "frontend/.env.production", ".signing/key", ".git/config", "data/database.sqlite", "node_modules/example/index.js", "desktop/src-tauri/target/release/app", "desktop/src-tauri/binaries/lumiverse-server-x86_64-unknown-linux-gnu", "desktop/src-tauri/tauri.release-updater.conf.json", "../outside", "/absolute"]) {
    expect(includeSnapshotPath(path)).toBe(false);
  }
  for (const path of ["src/index.ts", "frontend/.env.example", "desktop/src-tauri/src/frontend.rs", "scripts/linux-appimage-builder/Dockerfile", "frontend/src/lib/whistle/vendor/needle.js"]) {
    expect(includeSnapshotPath(path)).toBe(true);
  }
});

test("remote shell arguments preserve literal quotes and substitutions", () => {
  const input = "directory with 'quotes' and $(printf injected); `printf injected`";
  const result = Bun.spawnSync(["bash", "-c", `printf '%s' ${shellQuote(input)}`]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(input);
});
