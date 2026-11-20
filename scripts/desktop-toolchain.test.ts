import { describe, expect, test } from "bun:test";
import {
  currentDesktopPlatform,
  desktopBuildCommand,
  inspectDesktopToolchain,
  meetsVersion,
  MIN_BUN_VERSION,
  rustInstallRemedy,
} from "./desktop-toolchain";

test("the Windows build command initializes MSVC instead of invoking Tauri directly", () => {
  expect(desktopBuildCommand("windows")).toBe(".\\start.ps1 -InstallDesktop");
  expect(desktopBuildCommand("macos")).toContain("bun run tauri:finalized build");
});

describe("meetsVersion", () => {
  test("accepts an exact match", () => {
    expect(meetsVersion("1.4.0", "1.4.0")).toBe(true);
  });

  test("accepts newer versions at every position", () => {
    expect(meetsVersion("2.0.0", "1.4.0")).toBe(true);
    expect(meetsVersion("1.5.0", "1.4.0")).toBe(true);
    expect(meetsVersion("1.4.1", "1.4.0")).toBe(true);
  });

  test("rejects older versions at every position", () => {
    expect(meetsVersion("0.9.9", "1.4.0")).toBe(false);
    expect(meetsVersion("1.3.9", "1.4.0")).toBe(false);
    expect(meetsVersion("1.4.0", "1.4.1")).toBe(false);
  });

  test("does not compare version parts as strings", () => {
    // A lexicographic comparison would call "1.10.0" older than "1.9.0".
    expect(meetsVersion("1.10.0", "1.9.0")).toBe(true);
  });

  test("treats missing trailing parts as zero", () => {
    expect(meetsVersion("1.4", "1.4.0")).toBe(true);
    expect(meetsVersion("1.4", "1.4.1")).toBe(false);
    expect(meetsVersion("1.4.0.1", "1.4.0")).toBe(true);
  });

  test("treats unparseable parts as zero rather than throwing", () => {
    expect(meetsVersion("1.4.0-canary", "1.4.0")).toBe(true);
    expect(() => meetsVersion("", "1.4.0")).not.toThrow();
  });
});

describe("rustInstallRemedy", () => {
  test("prints runnable PowerShell commands on native Windows", () => {
    const remedy = rustInstallRemedy("windows").join("\n");
    expect(remedy).toContain("Invoke-WebRequest");
    expect(remedy).toContain("& $rustup");
    expect(remedy).toContain("win.rustup.rs/$arch");
    expect(remedy).not.toContain("| sh");
    expect(remedy).not.toContain("download rustup-init.exe");
  });

  test("keeps the rustup shell command on Unix platforms", () => {
    for (const target of ["macos", "linux"] as const) {
      const remedy = rustInstallRemedy(target).join("\n");
      expect(remedy).toContain("https://sh.rustup.rs | sh");
      expect(remedy).not.toContain("Invoke-WebRequest");
    }
  });
});

describe("inspectDesktopToolchain", () => {
  test("always reports on Bun and Rust", async () => {
    const report = await inspectDesktopToolchain();
    const ids = report.checks.map((check) => check.id);
    expect(ids).toContain("bun");
    expect(ids).toContain("cargo");
  });

  test("every check is fully populated", async () => {
    const report = await inspectDesktopToolchain();
    expect(report.checks.length).toBeGreaterThan(0);
    for (const check of report.checks) {
      expect(check.id).toBeTruthy();
      expect(check.label).toBeTruthy();
      expect(check.detail).toBeTruthy();
      expect(["ok", "missing", "unverified"]).toContain(check.status);
      expect(Array.isArray(check.remedy)).toBe(true);
    }
  });

  test("anything reported missing tells the user how to fix it", async () => {
    const report = await inspectDesktopToolchain();
    for (const check of report.checks) {
      if (check.status !== "missing") continue;
      expect(check.remedy.length).toBeGreaterThan(0);
    }
  });

  test("readiness ignores unverified checks and fails only on missing ones", async () => {
    const report = await inspectDesktopToolchain();
    const hasMissing = report.checks.some((check) => check.status === "missing");
    expect(report.ready).toBe(!hasMissing);
  });

  test("reports a platform the doctor knows how to label", async () => {
    const report = await inspectDesktopToolchain();
    expect(["macos", "windows", "linux", "other"]).toContain(report.platform);
    expect(report.platform).toBe(currentDesktopPlatform());
  });

  test("the suite itself runs on a Bun new enough to build the desktop app", () => {
    // Guards the floor the wizard and doctor both check against.
    expect(meetsVersion(Bun.version, MIN_BUN_VERSION)).toBe(true);
  });
});
