import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { initIdentity } from "../crypto/init";
import { env } from "../env";
import * as managerSvc from "../spindle/manager.service";
import { readExtensionArchive } from "./extensions";

const MANIFEST = strToU8(JSON.stringify({ identifier: "quiet_toolbox" }));

describe("readExtensionArchive", () => {
  test("reads an extension whose manifest is at the top of the archive", () => {
    const files = readExtensionArchive(zipSync({ "spindle.json": MANIFEST, "dist/backend.js": strToU8("x") }));
    expect([...files.keys()].sort()).toEqual(["dist/backend.js", "spindle.json"]);
  });

  test("installs the contents of the folders a repository download wraps around it", () => {
    const files = readExtensionArchive(zipSync({
      "quiet-toolbox-main/inner/spindle.json": MANIFEST,
      "quiet-toolbox-main/inner/src/backend.ts": strToU8("x"),
      "quiet-toolbox-main/.DS_Store": strToU8("x"),
      "__MACOSX/quiet-toolbox-main/._spindle.json": strToU8("x"),
    }));
    expect([...files.keys()].sort()).toEqual(["spindle.json", "src/backend.ts"]);
  });

  test("refuses an archive without a manifest at its top or inside one wrapping folder", () => {
    expect(() => readExtensionArchive(zipSync({
      "a/spindle.json": MANIFEST,
      "b/readme.md": strToU8("x"),
    }))).toThrow(/spindle.json/);
  });

  test("refuses traversal paths before writing extension files", () => {
    expect(() => readExtensionArchive(zipSync({
      "spindle.json": MANIFEST,
      "../outside.js": strToU8("x"),
    }))).toThrow(/unsafe path/);
  });
});

describe.serial("Illarin extension updates", () => {
  const originalDataDir = env.dataDir;
  let dataDir: string;

  beforeAll(async () => { await initIdentity(); });

  afterEach(() => {
    closeDatabase();
    env.dataDir = originalDataDir;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  function files(version: string, permissions: string[], seed: string): Map<string, Uint8Array> {
    return new Map([
      ["spindle.json", strToU8(JSON.stringify({
        identifier: "quiet_toolbox",
        name: "Quiet Toolbox",
        author: "Synthetic publisher",
        version,
        github: "https://github.com/example/quiet-toolbox",
        permissions,
        storage_seed_files: [{ from: "seed.txt", to: "config.txt", overwrite: true }],
      }))],
      ["seed.txt", strToU8(seed)],
    ]);
  }

  test("first install stays disabled; updates preserve grants and storage without approving new permissions", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "illarin-extension-test-"));
    env.dataDir = dataDir;
    closeDatabase();
    initDatabase(":memory:");
    getDb().run("PRAGMA foreign_keys = OFF");
    getDb().run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());

    const source = { illarin: { workId: "work-1", versionNumber: 1, permissionsApproved: false } };
    const installed = await managerSvc.installFromFiles(files("1.0.0", ["ui_panels"], "original"), source);
    expect(installed.enabled).toBe(false);
    expect(installed.granted_permissions).toEqual([]);
    expect(installed.metadata?.illarin).toEqual(source.illarin);

    managerSvc.grantPermission(installed.identifier, "ui_panels");
    managerSvc.setMetadataEntry(installed.identifier, "illarin", { ...source.illarin, permissionsApproved: true });
    managerSvc.enable(installed.identifier);
    const storageFile = join(dataDir, "extensions", installed.identifier, "storage", "config.txt");
    writeFileSync(storageFile, "owner edits");

    const updated = await managerSvc.replaceFromFiles(installed.identifier, files("2.0.0", ["ui_panels", "event_tracking"], "new seed"));
    expect(updated.enabled).toBe(true);
    expect(updated.granted_permissions).toContain("ui_panels");
    expect(updated.granted_permissions).not.toContain("event_tracking");
    expect(readFileSync(storageFile, "utf8")).toBe("owner edits");

    await managerSvc.syncManifestToDb(installed.identifier);
    expect((await managerSvc.getExtensionByIdentifier(installed.identifier))?.granted_permissions)
      .not.toContain("event_tracking");
    expect(managerSvc.listExtensionUpdateCandidates().map((candidate) => candidate.id)).not.toContain(installed.id);
  });
});
