import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { runMigrations } from "../../db/migrate";
import { env } from "../../env";
import {
  __test__,
  cancelImportForUser,
  getJob,
  isOwnedImportStagingPath,
  pruneTerminalImportJobs,
  reconcileUserDataImports,
  releaseImportUpload,
  reserveImportUpload,
  startImport,
  type ImportJob,
} from "./import.service";
import { getArchiveTableSpec } from "./table-registry";

const roots: string[] = [];

afterEach(async () => {

  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("foreign authority reset", () => {

  test("rebases only chat-mode authority counters and leaves the override inert", () => {
    const spec = getArchiveTableSpec("chat_agent_mode_overrides");
    const reset = __test__.authorityResetRow(
      "chat_agent_mode_overrides",
      {
        user_id: "foreign-user",
        chat_id: "chat-1",
        mode: "agentic",
        revision: 17,
        state: "ready",
        review_acknowledged: 1,
        review_code: null,
      },
      spec,
    );
    expect(reset).toMatchObject({
      mode: null,
      revision: 1,
      state: "review_required",
      review_acknowledged: 0,
      review_code: "foreign_import",
    });
  });

  test("clears imported image-generation public authority", () => {
    const reset = __test__.authorityResetRow(
      "images",
      {
        user_id: "foreign-user",
        id: "image-1",
        filename: "image-1.png",
        original_filename: "image-gen-provider.png",
        public_provenance: "server_image_generation_v1",
      },
      getArchiveTableSpec("images"),
    );
    expect(reset).toMatchObject({
      original_filename: "",
      public_provenance: null,
    });
  });
  test("marks every imported provider connection inert while preserving review metadata", () => {
    for (const table of ["connection_profiles", "image_gen_connections", "tts_connections", "stt_connections"]) {
      const reset = __test__.authorityResetRow(
        table,
        {
          user_id: "foreign-user",
          id: `${table}-1`,
          metadata: JSON.stringify({ label: "kept" }),
          has_api_key: 1,
        },
        getArchiveTableSpec(table),
      );
      const metadata = JSON.parse(reset.metadata);
      expect(metadata).toMatchObject({
        label: "kept",
        __lumiverse_import_review_required: true,
        __lumiverse_import_review_code: "foreign_import",
      });
      expect(reset.has_api_key).toBe(0);
    }
  });

  test("malformed imported provider metadata fails closed with a review marker", () => {
    const reset = __test__.authorityResetRow(
      "tts_connections",
      { user_id: "foreign-user", id: "tts-1", metadata: "{malformed" },
      getArchiveTableSpec("tts_connections"),
    );
    expect(JSON.parse(reset.metadata)).toEqual({
      __lumiverse_import_review_required: true,
      __lumiverse_import_review_code: "foreign_import",
    });
  });
});


describe("import startup staging containment", () => {
  test("accepts only the canonical user/job staging directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumiverse-import-root-"));
    roots.push(root);
    const canonical = join(root, "user-1", "job-1", "staging");
    expect(isOwnedImportStagingPath({ userId: "user-1", jobId: "job-1", stagingPath: canonical }, root)).toBe(true);
    expect(isOwnedImportStagingPath({ userId: "user-1", jobId: "job-1", stagingPath: `${canonical}/../staging` }, root)).toBe(false);
    expect(isOwnedImportStagingPath({ userId: "user-1/../user-2", jobId: "job-1", stagingPath: join(root, "user-2", "job-1", "staging") }, root)).toBe(false);
    expect(isOwnedImportStagingPath({ userId: "user-1", jobId: "job-1", stagingPath: join(root, "outside") }, root)).toBe(false);
  });

  test("rejects a staging symlink that escapes the registered imports root", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumiverse-import-root-"));
    roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "lumiverse-import-outside-"));
    roots.push(outside);
    const parent = join(root, "user-1", "job-1");
    await mkdir(parent, { recursive: true });
    const staging = join(parent, "staging");
    await symlink(outside, staging, "dir");
    expect(isOwnedImportStagingPath({ userId: "user-1", jobId: "job-1", stagingPath: staging }, root)).toBe(false);
    await rm(staging, { force: true });
    const internal = join(root, "internal-target");
    await mkdir(internal, { recursive: true });
    await symlink(internal, staging, "dir");
    expect(isOwnedImportStagingPath({ userId: "user-1", jobId: "job-1", stagingPath: staging }, root)).toBe(false);
    expect(await Bun.file(join(outside, "sentinel")).exists()).toBe(false);
  });
});

