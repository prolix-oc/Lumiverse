import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairMixedLanceManifestPaths } from "./lancedb-manifests";

function withTable(files: Record<string, string>, run: (tableDir: string, versionsDir: string) => void): void {
  const tableDir = mkdtempSync(join(tmpdir(), "lance-manifest-test-"));
  const versionsDir = join(tableDir, "_versions");
  try {
    mkdirSync(versionsDir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(versionsDir, name), content);
    run(tableDir, versionsDir);
  } finally {
    rmSync(tableDir, { recursive: true, force: true });
  }
}

describe("mixed LanceDB manifest repair", () => {
  test("preserves all versions and original bytes, using exact 64-bit arithmetic", () => {
    withTable({
      "1.manifest": "first",
      "9007199254740993.manifest": "beyond JS integer precision",
      "18446744073709551613.manifest": "second",
      "latest_version_hint.json": '{"version":2}',
      ".tmp_3.manifest_pending": "incomplete commit",
      "d9223372036854775808.manifest": "detached version",
    }, (tableDir, versionsDir) => {
      const { migrated, backupPath } = repairMixedLanceManifestPaths(tableDir);
      expect(migrated).toBe(2);
      expect(backupPath).not.toBeNull();
      expect(readFileSync(join(versionsDir, "18446744073709551614.manifest"), "utf8")).toBe("first");
      expect(readFileSync(join(versionsDir, "18437736874454810622.manifest"), "utf8")).toBe("beyond JS integer precision");
      expect(readFileSync(join(versionsDir, "18446744073709551613.manifest"), "utf8")).toBe("second");
      expect(readFileSync(join(backupPath!, "1.manifest"), "utf8")).toBe("first");
      expect(readFileSync(join(backupPath!, "9007199254740993.manifest"), "utf8")).toBe("beyond JS integer precision");
      expect(existsSync(join(versionsDir, "1.manifest"))).toBe(false);
      expect(readFileSync(join(versionsDir, ".tmp_3.manifest_pending"), "utf8")).toBe("incomplete commit");
      expect(readFileSync(join(versionsDir, "latest_version_hint.json"), "utf8")).toBe('{"version":2}');
      expect(readFileSync(join(versionsDir, "d9223372036854775808.manifest"), "utf8")).toBe("detached version");
      expect(repairMixedLanceManifestPaths(tableDir)).toEqual({ migrated: 0, backupPath: null });
    });
  });

  test("resumes a partial migration with an identical destination already present", () => {
    withTable({
      "1.manifest": "first",
      "2.manifest": "second",
      "18446744073709551614.manifest": "first",
    }, (tableDir, versionsDir) => {
      const result = repairMixedLanceManifestPaths(tableDir);
      expect(result.migrated).toBe(2);
      expect(readdirSync(versionsDir).sort()).toEqual([
        "18446744073709551613.manifest", "18446744073709551614.manifest",
      ]);
      expect(readFileSync(join(result.backupPath!, "1.manifest"), "utf8")).toBe("first");
      expect(readFileSync(join(versionsDir, "18446744073709551613.manifest"), "utf8")).toBe("second");
    });
  });

  test("refuses divergent versions before moving any files", () => {
    const files = {
      "1.manifest": "first",
      "2.manifest": "original second",
      "18446744073709551613.manifest": "different second",
    };
    withTable(files, (tableDir, versionsDir) => {
      expect(() => repairMixedLanceManifestPaths(tableDir)).toThrow("Conflicting LanceDB manifests for version 2");
      expect(readdirSync(tableDir)).toEqual(["_versions"]);
      expect(readdirSync(versionsDir).sort()).toEqual(Object.keys(files).sort());
      for (const [name, content] of Object.entries(files)) {
        expect(readFileSync(join(versionsDir, name), "utf8")).toBe(content);
      }
    });
  });

  test.each(["1.manifest", "18446744073709551614.manifest"])("leaves a healthy table with %s unchanged", (name) => {
    withTable({ [name]: "healthy" }, (tableDir, versionsDir) => {
      expect(repairMixedLanceManifestPaths(tableDir)).toEqual({ migrated: 0, backupPath: null });
      expect(readdirSync(tableDir)).toEqual(["_versions"]);
      expect(readFileSync(join(versionsDir, name), "utf8")).toBe("healthy");
    });
  });
});
