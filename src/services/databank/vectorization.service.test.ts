import { beforeEach, describe, expect, mock, test } from "bun:test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let chunks: any[];
let status: string;
let fileContent: string;
let pauseAt: "delete" | "upsert";
let paused: ReturnType<typeof deferred<void>>;
let resume: ReturnType<typeof deferred<void>>;
let deleteCount: number;
let upsertCount: number;
const vectors = new Map<string, string>();
const parsedContents: string[] = [];

mock.module("../../ws/bus", () => ({ eventBus: { emit() {} } }));
mock.module("./databank-crud.service", () => ({
  getDocument: () => ({ id: "doc", databankId: "bank", name: "Document", filePath: "doc.md" }),
  updateDocumentStatus: (_id: string, value: string) => { status = value; },
  getChunksForDocument: () => chunks,
  deleteChunksForDocument: () => { chunks = []; },
  insertChunks: (value: any[]) => { chunks = value; },
  updateChunkVectorization: (ids: string[]) => {
    chunks.forEach((chunk) => { if (ids.includes(chunk.id)) chunk.vectorized = true; });
  },
}));
mock.module("./document-parser.service", () => ({
  parseDocument: async () => { parsedContents.push(fileContent); return { text: fileContent }; },
}));
mock.module("./databank-settings.service", () => ({
  loadDatabankSettings: () => ({ chunkTargetTokens: 800, chunkMaxTokens: 1600, chunkOverlapTokens: 120 }),
}));
mock.module("../embeddings.service", () => ({
  deleteDatabankChunksByIds: async (_user: string, ids: string[]) => {
    if (++deleteCount === 1 && pauseAt === "delete") { paused.resolve(); await resume.promise; }
    ids.forEach((id) => vectors.delete(id));
  },
  getEmbeddingConfig: async () => ({ enabled: true, model: "test-model", batch_size: 20 }),
  embedInBatches: async (_user: string, rows: any[], _size: number, getText: any, onReady: any) => {
    await onReady(rows, rows.map(getText), rows.map(() => [1, 2]));
  },
  batchUpsertDatabankVectors: async (_user: string, rows: any[]) => {
    if (++upsertCount === 1 && pauseAt === "upsert") { paused.resolve(); await resume.promise; }
    rows.forEach((row) => vectors.set(row.chunkId, row.content));
  },
}));

const { processDocument, abortDocumentProcessing } = await import("./vectorization.service");

beforeEach(() => {
  chunks = [{ id: "original-chunk", content: "original" }];
  status = "ready";
  fileContent = "older content";
  pauseAt = "delete";
  paused = deferred<void>();
  resume = deferred<void>();
  deleteCount = 0;
  upsertCount = 0;
  vectors.clear();
  parsedContents.length = 0;
});

function expectCurrentContent() {
  expect(status).toBe("ready");
  expect(chunks.map((chunk) => chunk.content)).toEqual(["newer content"]);
  expect(chunks.every((chunk) => chunk.vectorized)).toBe(true);
  expect([...vectors.entries()]).toEqual([[chunks[0].id, "newer content"]]);
}

describe("document processing supersession", () => {
  test("an older vector deletion cannot replace newer chunks", async () => {
    const older = processDocument("user", "doc");
    await paused.promise;
    fileContent = "newer content";
    const newer = processDocument("user", "doc");
    // Let any unblocked work finish before the older operation resumes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resume.resolve();
    await Promise.all([older, newer]);
    expectCurrentContent();
  });

  test("an in-flight older vector write is removed before the new run completes", async () => {
    pauseAt = "upsert";
    const older = processDocument("user", "doc");
    await paused.promise;
    fileContent = "newer content";
    const newer = processDocument("user", "doc");
    await new Promise((resolve) => setTimeout(resolve, 0));
    resume.resolve();
    await Promise.all([older, newer]);
    expectCurrentContent();
  });

  test("a superseded waiting run does not start processing", async () => {
    const older = processDocument("user", "doc");
    await paused.promise;
    fileContent = "intermediate content";
    const intermediate = processDocument("user", "doc");
    fileContent = "newer content";
    const newer = processDocument("user", "doc");
    resume.resolve();
    await Promise.all([older, intermediate, newer]);
    expect(parsedContents).toEqual(["older content", "newer content"]);
    expectCurrentContent();
  });

  test("cancellation during vector deletion preserves the existing chunk rows", async () => {
    const run = processDocument("user", "doc");
    await paused.promise;
    abortDocumentProcessing("doc");
    resume.resolve();
    await run;
    expect(chunks).toEqual([{ id: "original-chunk", content: "original" }]);
    expect(upsertCount).toBe(0);
  });
});
