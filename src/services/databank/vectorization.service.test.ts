import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { env } from "../../env";
import * as embeddingsSvc from "../embeddings.service";
import type { EmbeddingConfigWithStatus } from "../embeddings.service";
import * as crud from "./databank-crud.service";
import { processDocument } from "./vectorization.service";

const USER_ID = "databank-vectorization-user";
const originalDataDir = env.dataDir;
let dataDir = "";

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(
    await Bun.file(join(import.meta.dir, "..", "..", "db", "baseline.sql")).text(),
  );
  dataDir = mkdtempSync(join(tmpdir(), "lumiverse-databank-vectorization-"));
  env.dataDir = dataDir;
  mkdirSync(join(dataDir, "databank", USER_ID), { recursive: true });
});

afterEach(() => {
  closeDatabase();
  env.dataDir = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("databank document processing recovery", () => {
  test("persists a safe failure and clears it after a successful retry with ready chunks", async () => {
    const bank = crud.createDatabank(USER_ID, {
      name: "Recovery bank",
      scope: "global",
    });
    const filename = "recoverable.txt";
    const document = crud.createDocument(
      USER_ID,
      bank.id,
      "Recoverable document",
      filename,
      "text/plain",
      32,
      "missing-file-hash",
    );
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await processDocument(USER_ID, document.id);

      expect(crud.getDocument(USER_ID, document.id)).toMatchObject({
        status: "error",
        errorMessage: "Document processing failed",
        totalChunks: 0,
      });

      writeFileSync(
        join(dataDir, "databank", USER_ID, filename),
        "Recovered source content becomes a searchable native Databank chunk.",
      );
      const embeddingConfigSpy = spyOn(
        embeddingsSvc,
        "getEmbeddingConfig",
      ).mockImplementation(async () => ({ enabled: false }) as EmbeddingConfigWithStatus);
      try {
        await processDocument(USER_ID, document.id);
      } finally {
        embeddingConfigSpy.mockRestore();
      }

      const recovered = crud.getDocument(USER_ID, document.id);
      const chunks = crud.getChunksForDocument(document.id);
      expect(recovered).toMatchObject({
        status: "ready",
        errorMessage: null,
        totalChunks: chunks.length,
      });
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map((chunk) => chunk.content).join("\n")).toContain(
        "Recovered source content",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
