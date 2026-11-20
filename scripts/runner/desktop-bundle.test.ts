import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { selectDesktopBundleArtifact } from "./git-ops.js";

const created: string[] = [];

function fixture(build: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-bundle-"));
  created.push(root);
  build(root);
  return root;
}

function touch(root: string, dir: string, name: string): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, name), "");
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("selectDesktopBundleArtifact", () => {
  test("returns null when the bundle root does not exist", () => {
    expect(selectDesktopBundleArtifact(join(tmpdir(), "lumiverse-no-such-bundle-root"))).toBeNull();
  });

  test("finds the macOS app bundle by its exact name", () => {
    const root = fixture((dir) => {
      mkdirSync(join(dir, "macos", "Lumiverse Desktop.app"), { recursive: true });
    });
    expect(selectDesktopBundleArtifact(root)).toBe(join(root, "macos", "Lumiverse Desktop.app"));
  });

  test("prefers the app bundle over the dmg when both were produced", () => {
    const root = fixture((dir) => {
      mkdirSync(join(dir, "macos", "Lumiverse Desktop.app"), { recursive: true });
      touch(dir, "dmg", "Lumiverse Desktop_0.1.0_aarch64.dmg");
    });
    expect(selectDesktopBundleArtifact(root)).toContain("Lumiverse Desktop.app");
  });

  test("finds version-stamped artifacts by extension", () => {
    for (const [dir, name] of [
      ["msi", "Lumiverse Desktop_0.1.0_x64_en-US.msi"],
      ["appimage", "lumiverse-desktop_0.1.0_amd64.AppImage"],
      ["deb", "lumiverse-desktop_0.1.0_amd64.deb"],
    ] as const) {
      const root = fixture((base) => touch(base, dir, name));
      expect(selectDesktopBundleArtifact(root)).toBe(join(root, dir, name));
    }
  });

  test("ignores files that are not installable artifacts", () => {
    const root = fixture((dir) => {
      touch(dir, "dmg", "bundle_dmg.sh");
      touch(dir, "dmg", "Lumiverse Desktop_0.1.0_aarch64.dmg");
    });
    expect(selectDesktopBundleArtifact(root)).toBe(
      join(root, "dmg", "Lumiverse Desktop_0.1.0_aarch64.dmg"),
    );
  });

  test("prefers the most recently written artifact over a lexicographically later stale one", () => {
    // bundle/ is never cleared between builds. A leftover 0.9.0 dmg sorts
    // *after* a fresh 0.10.0 by name; only mtime tells them apart.
    const root = fixture((dir) => {
      touch(dir, "dmg", "Lumiverse Desktop_0.9.0_aarch64.dmg");
      touch(dir, "dmg", "Lumiverse Desktop_0.10.0_aarch64.dmg");
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(join(dir, "dmg", "Lumiverse Desktop_0.9.0_aarch64.dmg"), old, old);
    });
    expect(selectDesktopBundleArtifact(root)).toBe(
      join(root, "dmg", "Lumiverse Desktop_0.10.0_aarch64.dmg"),
    );
  });

  test("falls back to the bundle root when it holds nothing recognisable", () => {
    // A directory the user can open beats reporting nothing at all.
    const root = fixture((dir) => touch(dir, "unknown-target", "artifact.bin"));
    expect(selectDesktopBundleArtifact(root)).toBe(root);
  });

  test("skips an empty artifact directory rather than returning it", () => {
    const root = fixture((dir) => {
      mkdirSync(join(dir, "dmg"), { recursive: true });
      touch(dir, "appimage", "lumiverse-desktop_0.1.0_amd64.AppImage");
    });
    expect(selectDesktopBundleArtifact(root)).toContain(".AppImage");
  });
});
