import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import * as generateSvc from "../services/generate.service";
import { storeBreakdown } from "../services/breakdown.service";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { WorkerHost } from "./worker-host";
import { providerRegistry } from "./provider-registry";

const dryRun = spyOn(generateSvc, "dryRunGeneration");
beforeAll(() => {
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE message_breakdowns (
    message_id TEXT PRIMARY KEY, chat_id TEXT, user_id TEXT, data TEXT NOT NULL
  )`);
});
afterAll(() => {
  dryRun.mockRestore();
  closeDatabase();
});
afterEach(() => {
  dryRun.mockReset();
  providerRegistry.reset();
  getDb().run("DELETE FROM message_breakdowns");
});

function fixture(scope: "user" | "operator" = "user", permitted = true) {
  const host = new WorkerHost("generation-api-test", {
    identifier: "generation-api-test", name: "Generation API test",
  } as SpindleManifest, {
    id: "generation-api-test", identifier: "generation-api-test", name: "Generation API test",
    version: "0.0.0", author: "", description: "", github: "", homepage: "",
    permissions: [], granted_permissions: [], enabled: true, installed_at: 0, updated_at: 0,
    has_frontend: false, has_backend: false, status: "stopped",
    metadata: { install_scope: scope, installed_by_user_id: "alice" },
  } satisfies ExtensionInfo);
  const internal = host as unknown as {
    hasPermission(permission: string): boolean;
    handleMessage(message: unknown): void;
    runtime: { mode: string; pid: null; postMessage(message: unknown): void; terminate(): void };
  };
  internal.hasPermission = permission => permitted && permission === "generation";
  return (message: Record<string, unknown>) => new Promise<any>(resolve => {
    internal.runtime = { mode: "worker", pid: null, postMessage: resolve, terminate() {} };
    internal.handleMessage({ requestId: "request", ...message });
  });
}

const baseResult: generateSvc.DryRunResult = {
  messages: [], breakdown: [], parameters: {}, model: "test", provider: "test",
};

test("dry run preserves context clipping statistics and a zero history-token count", async () => {
  const contextClipStats = {
    enabled: true, maxContext: 8192, maxResponseTokens: 1024, safetyMargin: 128,
    inputBudget: 7040, fixedTokens: 100, remainingHistoryBudget: 6940,
    chatHistoryTokensBefore: 8000, chatHistoryTokensAfter: 6900,
    messagesDropped: 2, tokensDropped: 1100, tokenizerUsed: "test",
  };
  dryRun.mockResolvedValue({ ...baseResult, chatHistoryTokens: 0, contextClipStats });
  const response = await fixture()({ type: "generate_dry_run", input: { chatId: "chat" } });
  expect(response).toMatchObject({ type: "response", requestId: "request", result: {
    ...baseResult, chatHistoryTokens: 0, contextClipStats,
  } });
  expect(dryRun.mock.calls[0]?.[0]).toMatchObject({ userId: "alice", chat_id: "chat" });
});

test("dry run leaves unavailable counts and clipping statistics undefined", async () => {
  dryRun.mockResolvedValue(baseResult);
  const response = await fixture()({ type: "generate_dry_run", input: { chatId: "chat" } });
  expect(response.result.chatHistoryTokens).toBeUndefined();
  expect(response.result.contextClipStats).toBeUndefined();
});

test("dry run still requires generation permission and enforces user scope", async () => {
  const request = { type: "generate_dry_run", input: { chatId: "chat" } };
  expect((await fixture("user", false)(request)).error).toContain("generation");
  expect((await fixture("operator")(request)).error).toContain("userId is required");
  expect(dryRun).not.toHaveBeenCalled();
  dryRun.mockResolvedValue(baseResult);
  await fixture()({ ...request, userId: "bob" });
  expect(dryRun.mock.calls[0]?.[0].userId).toBe("alice");
});

const saved = {
  entries: [{ name: "System", type: "block", tokens: 10, content: "Synthetic prompt" }],
  messages: [{ role: "system", content: "Synthetic prompt" }],
  totalTokens: 30, chatHistoryTokens: 20, maxContext: 8192,
  model: "test", provider: "test", parameters: { temperature: 0.5 },
  usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
  presetName: "Test", presetId: "preset", tokenizer_name: "test",
};

test("saved breakdowns return the stored snapshot without generating a prompt", async () => {
  storeBreakdown("alice", "message", "chat", saved);
  const response = await fixture()({ type: "generate_get_breakdown", messageId: "message" });
  expect(response).toEqual({ type: "response", requestId: "request", result: saved });
  expect(dryRun).not.toHaveBeenCalled();
});

test("saved breakdown reads cannot escape the extension owner's scope", async () => {
  storeBreakdown("alice", "alice-message", "alice-chat", saved);
  storeBreakdown("bob", "bob-message", "bob-chat", { ...saved, model: "bob-private" });
  const send = fixture();
  expect((await send({ type: "generate_get_breakdown", messageId: "bob-message", userId: "bob" })).result).toBeNull();
  expect((await send({ type: "generate_get_breakdown", messageId: "alice-message", userId: "bob" })).result).toEqual(saved);
});

test("saved breakdown reads require generation permission and an operator user context", async () => {
  const request = { type: "generate_get_breakdown", messageId: "message" };
  expect((await fixture("user", false)(request)).error).toContain("generation");
  expect((await fixture("operator")(request)).error).toContain("userId is required");
  storeBreakdown("bob", "message", "chat", saved);
  expect((await fixture("operator")({ ...request, userId: "bob" })).result).toEqual(saved);
});

test("absent or unreadable snapshots return null; invalid message IDs reject", async () => {
  const send = fixture();
  storeBreakdown("alice", "corrupt", "chat", "invalid JSON");
  storeBreakdown("alice", "old", "chat", { entries: [], totalTokens: 0 });
  for (const messageId of ["missing", "corrupt"]) {
    expect((await send({ type: "generate_get_breakdown", messageId })).result).toBeNull();
  }
  expect((await send({ type: "generate_get_breakdown", messageId: "old" })).result).toEqual({ entries: [], totalTokens: 0 });
  for (const messageId of [undefined, "", "  ", 123]) {
    expect((await send({ type: "generate_get_breakdown", messageId })).error).toBe("messageId is required");
  }
});

test("extension runtime round-trips preview fields, saved snapshots, nulls and errors through the host", async () => {
  storeBreakdown("bob", "message", "chat", saved);
  dryRun.mockResolvedValue({ ...baseResult, chatHistoryTokens: 42 });
  const directory = await mkdtemp(join(tmpdir(), "spindle-generation-test-"));
  const entry = join(directory, "backend.mjs");
  await Bun.write(entry, `
    const preview = await spindle.generate.dryRun({ chatId: "chat" }, "bob");
    const saved = await spindle.generate.getBreakdown("message", "bob");
    const missing = await spindle.generate.getBreakdown("missing", "bob");
    let error;
    try { await spindle.generate.getBreakdown("", "bob"); }
    catch (e) { error = e.message; }
    spindle.sendToFrontend({ preview, saved, missing, error });
  `);
  const dispatch = fixture("operator");
  let resolveResult!: (message: any) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<any>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const timer = setTimeout(() => rejectResult(new Error("Extension did not return generation results")), 5000);
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, "worker-runtime.ts")], {
    stdout: "ignore", stderr: "pipe",
    ipc(message: any, child) {
      if (message.type === "permissions_get_granted") {
        child.send({ type: "response", requestId: message.requestId, result: ["generation"] });
      } else if (message.type === "generate_dry_run" || message.type === "generate_get_breakdown") {
        void dispatch(message).then(response => child.send(response)).catch(rejectResult);
      } else if (message.type === "frontend_message") {
        resolveResult(message.payload);
      }
    },
  });
  try {
    worker.send({ type: "init", manifest: { identifier: "generation-test", entry_backend: pathToFileURL(entry).href }, storagePath: directory });
    const response = await result;
    expect(response.preview.chatHistoryTokens).toBe(42);
    expect(response.saved).toEqual(saved);
    expect(response.missing).toBeNull();
    expect(response.error).toBe("messageId is required");
    expect(dryRun.mock.calls[0]?.[0].userId).toBe("bob");
  } finally {
    clearTimeout(timer);
    worker.kill();
    await worker.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
