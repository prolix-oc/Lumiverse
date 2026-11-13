import { afterEach, expect, spyOn, test } from "bun:test";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import * as chats from "../services/chats.service";
import { WorkerHost } from "./worker-host";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

function fixture(permitted = true, owner = "alice") {
  const current = { id: "message", chat_id: "chat", swipe_id: 1, swipes: ["A", "B"], extra: {
    reasoning: "old B", reasoningDuration: 20, reasoningBySwipe: ["old A", "old B"], reasoningDurationBySwipe: [10, 20],
    tokenCount: 2, tokenCountBySwipe: [1, 2], usage: { total_tokens: 2 }, usageBySwipe: [{ total_tokens: 1 }, { total_tokens: 2 }],
    spindle_metadata: { custom: "retained" }, attachments: [{ id: "attachment" }],
  } };
  const read = spyOn(chats, "getMessage").mockReturnValue(current as any);
  const write = spyOn(chats, "updateMessage").mockReturnValue(current as any);
  spies.push(read, write);
  const host = new WorkerHost("reasoning-test", { identifier: "reasoning-test", name: "Reasoning test" } as SpindleManifest, {
    id: "reasoning-test", identifier: "reasoning-test", name: "Reasoning test", version: "0.0.0", author: "",
    description: "", github: "", homepage: "", permissions: [], granted_permissions: [], enabled: true,
    installed_at: 0, updated_at: 0, has_frontend: false, has_backend: false, status: "stopped",
    metadata: { install_scope: "user", installed_by_user_id: "alice" },
  } satisfies ExtensionInfo);
  const internal = host as any;
  internal.hasPermission = (permission: string) => permitted && permission === "chat_mutation";
  internal.getChatOwnerId = () => owner;
  const send = (patch: unknown, chatId = "chat") => new Promise<any>(resolve => {
    internal.runtime = { mode: "worker", pid: null, postMessage: resolve, terminate() {} };
    internal.handleMessage({ type: "chat_update_message", requestId: "request", chatId, messageId: "message", patch });
  });
  return { send, read, write, current };
}

test("a reasoning snapshot saves every slot in one write without changing selection or unrelated extra", async () => {
  const { send, write, current } = fixture();
  expect((await send({ swipes: ["new A", "new B"], swipe_reasoning: [{ text: "A", duration: 100 }, { text: "B", duration: 200 }], skipChunkRebuild: true })).result).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
  const input = write.mock.calls[0]![2];
  expect(input.swipe_id).toBeUndefined();
  expect(input.swipes).toEqual(["new A", "new B"]);
  expect(input.skipChunkRebuild).toBe(true);
  expect(input.extra).toEqual({
    reasoningBySwipe: ["A", "B"], reasoningDurationBySwipe: [100, 200],
    tokenCountBySwipe: [1, 2], usageBySwipe: [{ total_tokens: 1 }, { total_tokens: 2 }],
    spindle_metadata: { custom: "retained" }, attachments: [{ id: "attachment" }],
  });
  expect(current.extra.reasoning).toBe("old B");
});

test("null slots and omitted durations clear old values, including with navigation and resized swipes", async () => {
  const { send, write } = fixture();
  expect((await send({ swipes: ["C", "D", "E"], swipe_id: 0,
    swipe_reasoning: [null, { text: "new" }, { text: null, duration: null }], metadata: { other: true } })).result).toBe(true);
  const patch = write.mock.calls[0]![2];
  expect(patch.swipe_id).toBe(0);
  expect(patch.extra).toMatchObject({ reasoningBySwipe: [null, "new", null], reasoningDurationBySwipe: [null, null, null], spindle_metadata: { other: true }, tokenCountBySwipe: [1, 2] });
  expect(patch.extra!.tokenCount).toBeUndefined();
  expect(patch.extra!.reasoning).toBeUndefined();
});

test("invalid snapshots fail before any content or metadata write", async () => {
  const { send, write } = fixture();
  for (const swipe_reasoning of [null, {}, [], [null], [null, null, null], [undefined, null],
    [{}, null], [{ text: 1 }, null], [{ text: "a", duration: -1 }, null],
    [{ text: "a", duration: NaN }, null], [{ text: "a", duration: Infinity }, null], [{ text: "a", duration: "1" }, null]]) {
    expect((await send({ swipe_reasoning, content: "do not save", metadata: { overwritten: true } })).error).toContain("swipe_reasoning");
  }
  expect((await send({ swipe_reasoning: [null, null], reasoning: { text: "ambiguous" } })).error).toContain("not both");
  expect(write).not.toHaveBeenCalled();
});

test("existing selected-swipe reasoning and ordinary content patches keep their behavior", async () => {
  const { send, write } = fixture();
  await send({ reasoning: { text: "selected", duration: null } });
  expect(write.mock.calls[0]![2].extra).toMatchObject({ reasoning: "selected", reasoningDuration: null, reasoningBySwipe: ["old A", "old B"] });
  await send({ content: "ordinary" });
  expect(write.mock.calls[1]![2].extra).toBeUndefined();
});

test("reasoning writes still require mutation permission", async () => {
  const { send, read, write } = fixture(false);
  expect((await send({ swipe_reasoning: [null, null] })).error).toContain("chat_mutation");
  expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});

test("reasoning writes cannot cross extension user scope", async () => {
  const { send, read, write } = fixture(true, "bob");
  expect((await send({ swipe_reasoning: [null, null] })).error).toContain("user-scoped");
  expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});

test("reasoning writes cannot target a message in a different chat", async () => {
  const { send, write } = fixture();
  expect((await send({ swipe_reasoning: [null, null] }, "other-chat")).error).toBe("Message not found");
  expect(write).not.toHaveBeenCalled();
});
