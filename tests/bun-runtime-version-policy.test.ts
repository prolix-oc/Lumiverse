import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { meetsVersion, MIN_BUN_VERSION } from "../scripts/desktop-toolchain";
import {
  MINIMUM_BUN_VERSION,
  canTrustCurrentBunRuntime,
  meetsBunVersion,
  requiredBunVersion,
  windowsRuntimeRoot,
} from "../src/runtime/bun-runtime";

const root = join(import.meta.dir, "..");
// The first Git Bash launch on Windows runners can exceed Bun's default 5s.
// Keep a process deadline as well as the test deadline so hangs still fail.
const shellTestTimeoutMs = process.platform === "win32" ? 30_000 : 5_000;

async function read(path: string): Promise<string> {
  return (await Bun.file(join(root, path)).text()).replace(/\r\n/g, "\n");
}

describe("Bun runtime version policy", () => {
  test("keeps runtime, types, Docker, desktop CI, and launchers on 1.4.4", async () => {
    const [rootPackage, frontendPackage, dockerfile, desktopBuild, desktopRelease, unixLauncher, windowsLauncher, backendRuntime, desktopRunner] =
      await Promise.all([
        Bun.file(join(root, "package.json")).json(),
        Bun.file(join(root, "frontend", "package.json")).json(),
        read("Dockerfile"),
        read(".github/workflows/desktop-build.yml"),
        read(".github/workflows/desktop-release.yml"),
        read("start.sh"),
        read("start.ps1"),
        read("src/index.ts"),
        read("scripts/runner.ts"),
      ]);

    expect(rootPackage.packageManager).toBe("bun@1.4.4");
    expect(rootPackage.engines?.bun).toBe(">=1.4.4");
    const desktopPackage = await Bun.file(join(root, "desktop/package.json")).json();
    expect(desktopPackage.packageManager).toBe(rootPackage.packageManager);
    expect(desktopPackage.engines?.bun).toBe(rootPackage.engines.bun);
    expect(rootPackage.devDependencies?.["bun-types"]).toBe("^1.4.4");
    expect(frontendPackage.devDependencies?.["bun-types"]).toBe("^1.4.4");
    expect(MIN_BUN_VERSION).toBe("1.4.4");

    const pinnedImage =
      "oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4";
    expect(dockerfile.match(new RegExp(pinnedImage, "g"))).toHaveLength(3);
    expect(desktopBuild).toContain("bun-version: 1.4.4");
    expect(desktopRelease).toContain("bun-version: 1.4.4");
    expect(unixLauncher).toContain('MINIMUM_BUN_VERSION="1.4.4"');
    expect(windowsLauncher).toContain('$MinimumBunVersion = [version]"1.4.4"');
    expect(MINIMUM_BUN_VERSION).toBe("1.4.4");
    expect(requiredBunVersion(root)).toBe("1.4.4");
    expect(backendRuntime).toContain("await bootstrapBunRuntime");
    expect(desktopRunner).toContain("await bootstrapBunRuntime");
    expect(await read("scripts/runner/server-manager.ts")).toContain("await ensureBunRuntime(PROJECT_ROOT)");
  });

  test("rejects 1.4.3 and keeps the PowerShell upgrade gate before mode dispatch", async () => {
    expect(meetsVersion("1.4.3", MIN_BUN_VERSION)).toBe(false);
    expect(meetsVersion("1.4.4", MIN_BUN_VERSION)).toBe(true);

    const launcher = await read("start.ps1");
    const gateStart = launcher.indexOf("function Ensure-MinimumBunVersion {");
    const gateEnd = launcher.indexOf("\n# ─── First-run setup wizard", gateStart);
    const gate = launcher.slice(gateStart, gateEnd);

    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);
    expect(gate.match(/Get-BunSemanticVersion/g)).toHaveLength(3);
    expect(gate).toContain('Invoke-BunUpgrade "stable"');
    expect(gate).toContain("Install-LumiverseBunRuntime");
    expect(gate).toContain("exit 1");
    expect(launcher).toContain("Ensure-Bun\nUpdate-BunChannel\nEnsure-MinimumBunVersion\n");
  });

  test("a checkout can raise the required Bun version but cannot lower the safety floor", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumiverse-bun-floor-"));
    try {
      for (const manifest of [
        { engines: { bun: ">=1.4.3" } },
        { packageManager: "bun@1.4.3" },
        {},
      ]) {
        writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
        expect(requiredBunVersion(directory)).toBe("1.4.4");
      }
      writeFileSync(join(directory, "package.json"), JSON.stringify({ engines: { bun: ">=1.5.0" } }));
      expect(requiredBunVersion(directory)).toBe("1.5.0");
      writeFileSync(join(directory, "package.json"), JSON.stringify({ packageManager: "bun@1.5.1" }));
      expect(requiredBunVersion(directory)).toBe("1.5.1");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test.each([
    { platform: "termux", before: "1.4.3", after: "1.4.4", success: true, components: ["bun", "wrapper"] },
    { platform: "termux", before: "1.4.4", after: "1.4.4", success: true, components: [] },
    { platform: "termux", before: "1.4.3", after: "unavailable", success: false, components: ["bun"] },
    { platform: "termux", before: "1.4.3", after: "1.4.3", success: false, components: ["bun"] },
    { platform: "termux", before: "1.4.3", after: "1.4.4", success: false, components: ["bun", "wrapper"], probeWorks: false },
    { platform: "linux", before: "1.4.3", after: "1.4.4", success: true, components: [] },
    { platform: "linux", before: "1.4.3", after: "unavailable", success: false, components: [] },
  ])("launcher enforces the Bun floor on $platform ($before -> $after)", async ({ platform, before, after, success, components, probeWorks = true }) => {
    const launcher = await read("start.sh");
    const section = (start: string, end: string) => {
      const from = launcher.indexOf(start);
      const to = launcher.indexOf(end, from);
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeGreaterThan(from);
      return launcher.slice(from, to);
    };
    const directory = mkdtempSync(join(tmpdir(), "lumiverse-bun-upgrade-"));
    const versionFile = join(directory, "version"), callsFile = join(directory, "calls");
    writeFileSync(versionFile, before);
    writeFileSync(callsFile, "");
    try {
      // Exercise the real upgrade/gate bodies. Only the external installer and
      // Android execution probe are replaced; no personal runtime is modified.
      const shell = [
        "set -euo pipefail",
        `IS_TERMUX=${platform === "termux"}; MINIMUM_BUN_VERSION=1.4.4`,
        "info() { :; }; ok() { :; }; warn() { :; }; err() { echo \"$*\" >&2; }",
        "_resolve_bun() { return 0; }",
        "verify_termux_bun_install_path() { if [[ \"$LUMIVERSE_TEST_PROBE_WORKS\" == false ]]; then echo 'Termux install probe failed' >&2; return 1; fi; }",
        "mock_install() { [[ \"$LUMIVERSE_TEST_NEXT_VERSION\" != unavailable ]] || return 1; printf '%s' \"$LUMIVERSE_TEST_NEXT_VERSION\" > \"$LUMIVERSE_TEST_VERSION_FILE\"; }",
        "_bun() { if [[ \"$1\" == --version ]]; then cat \"$LUMIVERSE_TEST_VERSION_FILE\"; else [[ \"$*\" == 'upgrade --stable' ]] || return 99; mock_install; fi; }",
        "update_bun_termux_components() { printf '%s\\n' \"$1\" >> \"$LUMIVERSE_TEST_CALLS_FILE\"; if [[ \"$1\" == bun ]]; then mock_install; fi; }",
        section("upgrade_bun_termux() {", "\nverify_termux_bun_install_path()"),
        section("upgrade_bun_channel() {", "\n# ─── First-run setup wizard"),
        "ensure_minimum_bun_version",
        "printf 'continued'",
      ].join("\n");
      const result = Bun.spawnSync(["bash", "-c", shell], {
        cwd: directory,
        timeout: shellTestTimeoutMs - 1_000,
        env: {
          ...process.env,
          LUMIVERSE_TEST_NEXT_VERSION: after,
          LUMIVERSE_TEST_PROBE_WORKS: String(probeWorks),
          LUMIVERSE_TEST_VERSION_FILE: "version",
          LUMIVERSE_TEST_CALLS_FILE: "calls",
        },
      });
      expect(result.exitCode).toBe(success ? 0 : 1);
      expect(result.stdout.toString().includes("continued")).toBe(success);
      expect(readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)).toEqual(components);
      if (success) expect(result.stderr.toString()).toBe("");
      else expect(result.stderr.toString()).toContain(probeWorks ? "still below the required 1.4.4" : "Termux install probe failed");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, shellTestTimeoutMs);

  test("selects a versioned Windows runtime and compares prerelease versions numerically", () => {
    expect(meetsBunVersion("1.4.3", "1.4.4")).toBe(false);
    expect(meetsBunVersion("1.4.4-canary.1", "1.4.4")).toBe(true);
    expect(meetsBunVersion("1.5.0", "1.4.4")).toBe(true);
    expect(windowsRuntimeRoot("1.4.4", {
      LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
    }, root)).toBe("C:\\Users\\Alice\\AppData\\Local\\Lumiverse\\runtimes\\bun-1.4.4");
  });

  test("trusts an already-running non-Windows Bun without probing its raw executable", () => {
    expect(canTrustCurrentBunRuntime("1.4.4", "1.4.4", "linux")).toBe(true);
    expect(canTrustCurrentBunRuntime("1.5.0", "1.4.4", "darwin")).toBe(true);
    expect(canTrustCurrentBunRuntime("1.4.3", "1.4.4", "linux")).toBe(false);
    // Keep Windows on the side-by-side runtime selection/probe path.
    expect(canTrustCurrentBunRuntime("1.4.4", "1.4.4", "win32")).toBe(false);
  });

  test("keeps launcher utility scripts behind the Termux-aware Bun wrapper", async () => {
    const launcher = await read("start.sh");

    const resetStart = launcher.indexOf("run_reset_password() {");
    const resetEnd = launcher.indexOf("\nrun_migrate_st()", resetStart);
    const resetFunction = launcher.slice(resetStart, resetEnd);

    const migrateStart = launcher.indexOf("run_migrate_st() {");
    const migrateEnd = launcher.indexOf("\nrun_edit_env()", migrateStart);
    const migrateFunction = launcher.slice(migrateStart, migrateEnd);

    const desktopCaseStart = launcher.indexOf("  install-desktop)");
    const desktopCaseEnd = launcher.indexOf("\n    ;;", desktopCaseStart);
    const desktopCase = launcher.slice(desktopCaseStart, desktopCaseEnd);

    expect(resetStart).toBeGreaterThanOrEqual(0);
    expect(resetEnd).toBeGreaterThan(resetStart);
    expect(migrateStart).toBeGreaterThanOrEqual(0);
    expect(migrateEnd).toBeGreaterThan(migrateStart);
    expect(desktopCaseStart).toBeGreaterThanOrEqual(0);
    expect(desktopCaseEnd).toBeGreaterThan(desktopCaseStart);

    expect(resetFunction).toContain("_bun run scripts/reset-password.ts");
    expect(resetFunction).not.toContain("_bun run reset-password");
    expect(migrateFunction).toContain("_bun run scripts/migrate-sillytavern.ts");
    expect(migrateFunction).not.toContain("_bun run migrate:st");
    expect(desktopCase).toContain("_bun run scripts/install-desktop.ts");
    expect(desktopCase).not.toContain("_bun run desktop:install");
  });

  test("routes utility script arguments through grun without invoking a package alias", async () => {
    const launcher = await read("start.sh");
    const section = (start: string, end: string) => {
      const from = launcher.indexOf(start);
      const to = launcher.indexOf(end, from);
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeGreaterThan(from);
      return launcher.slice(from, to);
    };
    // Exercise the real wrapper and utility bodies without installing packages,
    // opening personal data, or requiring an Android/glibc executable.
    const shell = [
      "set -euo pipefail",
      "IS_TERMUX=true; TERMUX_BUN_METHOD=grun; TERMUX_BUN_PATH=/mock/raw-bun; BACKEND_DIR=.",
      "install_deps() { :; }; info() { :; }",
      "bun() { echo 'raw Bun must not run' >&2; return 99; }",
      "grun() { printf '%s\\n' \"$*\"; }",
      section("_bun() {", "\n# Like _bun"),
      section("run_reset_password() {", "\nrun_edit_env()"),
      "run_reset_password",
      "run_migrate_st",
      section("  install-desktop)", "\n    ;;").replace("  install-desktop)", ""),
    ].join("\n");
    const result = Bun.spawnSync(["bash", "-c", shell], { cwd: root, timeout: shellTestTimeoutMs - 1_000 });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split(/\r?\n/)).toEqual([
      "/mock/raw-bun run scripts/reset-password.ts",
      "/mock/raw-bun run scripts/migrate-sillytavern.ts",
      "/mock/raw-bun run scripts/install-desktop.ts",
    ]);
  }, shellTestTimeoutMs);

  test("updates native Termux Bun and rebuilds its wrapper only when the version changes", async () => {
    const launcher = await read("start.sh");
    const upgradeStart = launcher.indexOf("upgrade_bun_channel() {");
    const upgradeEnd = launcher.indexOf("\nupgrade_bun_if_requested()", upgradeStart);
    const upgradeFunction = launcher.slice(upgradeStart, upgradeEnd);
    const standardPath = upgradeFunction.indexOf("# ── Standard path");
    const nativeTermuxPath = upgradeFunction.slice(0, standardPath);
    const helperStart = launcher.indexOf("upgrade_bun_termux() {");
    const helperEnd = launcher.indexOf("\nverify_termux_bun_install_path()", helperStart);
    const termuxUpgradeHelper = launcher.slice(helperStart, helperEnd);
    const runtimeUpdate = termuxUpgradeHelper.indexOf("update_bun_termux_components bun");
    const unchangedGate = termuxUpgradeHelper.indexOf('if [[ "$after" == "$before" ]]');
    const wrapperUpdate = termuxUpgradeHelper.indexOf("update_bun_termux_components wrapper");

    expect(upgradeStart).toBeGreaterThanOrEqual(0);
    expect(upgradeEnd).toBeGreaterThan(upgradeStart);
    expect(standardPath).toBeGreaterThanOrEqual(0);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(nativeTermuxPath).toContain('if [[ "$IS_TERMUX" == true ]]');
    expect(nativeTermuxPath).toContain('upgrade_bun_termux "$before"');
    expect(nativeTermuxPath).toContain("_resolve_bun");
    expect(nativeTermuxPath).toContain("verify_termux_bun_install_path");
    expect(nativeTermuxPath).not.toContain("_bun upgrade");
    expect(runtimeUpdate).toBeGreaterThanOrEqual(0);
    expect(unchangedGate).toBeGreaterThan(runtimeUpdate);
    expect(wrapperUpdate).toBeGreaterThan(unchangedGate);
    expect(termuxUpgradeHelper).toContain("Termux wrapper unchanged because the Bun version did not change");
    expect(termuxUpgradeHelper).not.toContain("update_bun_termux_components all");
    expect(nativeTermuxPath).toContain('ok "Bun $after is already up to date"');
    expect(nativeTermuxPath).toContain('ok "Bun upgraded via bun-termux: $before -> $after"');
    expect(launcher).toContain(
      "ensure_bun\nupgrade_bun_if_requested\nensure_minimum_bun_version\nexport_termux_bun_env",
    );
  });
});
