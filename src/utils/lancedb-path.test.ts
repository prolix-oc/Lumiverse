import { describe, expect, test } from "bun:test";
import { resolveBrokenTermuxLanceDbMirrorPath, resolveLanceDbConnectUri } from "./lancedb-path";

describe("resolveLanceDbConnectUri", () => {
  test("keeps absolute paths outside Termux", () => {
    expect(resolveLanceDbConnectUri("/srv/lumiverse/data/lancedb", {
      cwd: "/srv/lumiverse",
      env: {},
    })).toBe("/srv/lumiverse/data/lancedb");
  });

  test("uses a cwd-relative path for Termux workspaces", () => {
    expect(resolveLanceDbConnectUri("/data/data/com.termux/files/home/Lumiverse/data/lancedb", {
      cwd: "/data/data/com.termux/files/home/Lumiverse",
      env: { PREFIX: "/data/data/com.termux/files/usr" },
    })).toBe("data/lancedb");
  });

  test("does not manufacture a stripped Termux path when cwd is root", () => {
    expect(resolveLanceDbConnectUri("/data/data/com.termux/files/home/Lumiverse/data/lancedb", {
      cwd: "/",
      env: { PREFIX: "/data/data/com.termux/files/usr" },
    })).toBe("/data/data/com.termux/files/home/Lumiverse/data/lancedb");
  });

  test("uses a parent-relative path when the database is outside the cwd", () => {
    expect(resolveLanceDbConnectUri("/data/data/com.termux/files/home/shared/lancedb", {
      cwd: "/data/data/com.termux/files/home/Lumiverse",
      env: { TERMUX_VERSION: "0.119.0" },
    })).toBe("../shared/lancedb");
  });

  test("uses a parent-relative path for Termux data dirs outside the repo", () => {
    expect(resolveLanceDbConnectUri("/data/data/com.termux/files/home/data/lancedb", {
      cwd: "/data/data/com.termux/files/home/Lumiverse",
      env: { TERMUX_VERSION: "0.119.0" },
    })).toBe("../data/lancedb");
  });

  test("uses a parent-relative path when running in proot-distro", () => {
    expect(resolveLanceDbConnectUri("/home/darren/data/lancedb", {
      cwd: "/home/darren/Lumiverse-Backend",
      env: { LUMIVERSE_IS_PROOT: "true" },
    })).toBe("../data/lancedb");
  });

  test("resolves the broken Termux mirror path created by a stripped leading slash", () => {
    expect(resolveBrokenTermuxLanceDbMirrorPath("/data/data/com.termux/files/home/Lumiverse/data/lancedb", {
      cwd: "/data/data/com.termux/files/home/Lumiverse",
      env: { TERMUX_VERSION: "0.119.0" },
    })).toBe("/data/data/com.termux/files/home/Lumiverse/data/data/com.termux/files/home/Lumiverse/data/lancedb");
  });

  test("resolves the broken Termux mirror path for parent-relative data dirs", () => {
    expect(resolveBrokenTermuxLanceDbMirrorPath("/data/data/com.termux/files/home/data/lancedb", {
      cwd: "/data/data/com.termux/files/home/Lumiverse",
      env: { TERMUX_VERSION: "0.119.0" },
    })).toBe("/data/data/com.termux/files/home/Lumiverse/data/data/com.termux/files/home/data/lancedb");
  });

  test("does not report a broken mirror when no relative workaround is needed", () => {
    expect(resolveBrokenTermuxLanceDbMirrorPath("/srv/lumiverse/data/lancedb", {
      cwd: "/srv/lumiverse",
      env: {},
    })).toBeNull();
  });
});
