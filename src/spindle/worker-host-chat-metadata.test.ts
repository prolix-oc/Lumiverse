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
  const host = new WorkerHost("metadata-test", { identifier: "metadata-test", name: "Metadata test" } as SpindleManifest, {
    id: "metadata-test", identifier: "metadata-test", name: "Metadata test", version: "0.0.0", author: "",
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

test("metadata patches preserve other extensions' latest fields across streaming writes", async () => {
  const { send, write, current } = fixture();
  await send({ metadata_patch: { run: "first", nested: { old: true } } });
  expect(write.mock.calls[0]![2].extra!.spindle_metadata).toEqual({ custom: "retained", run: "first", nested: { old: true } });
  current.extra.spindle_metadata = { ...write.mock.calls[0]![2].extra!.spindle_metadata, other: { value: "written during streaming" } } as any;
  await send({ metadata_patch: { run: null, nested: { new: true } }, swipes: ["finished A", "finished B"] });
  expect(write.mock.calls[1]![2].extra!.spindle_metadata).toEqual({ custom: "retained", other: { value: "written during streaming" }, run: null, nested: { new: true } });
  expect(write.mock.calls[1]![2].extra!.attachments).toEqual([{ id: "attachment" }]);
});

test("metadata patches reject ambiguous and malformed requests before writing", async () => {
  const { send, write } = fixture();
  for (const metadata_patch of [null, [], "invalid", 1, true]) {
    expect((await send({ metadata_patch, content: "do not save" })).error).toContain("metadata_patch");
  }
  expect((await send({ metadata: {}, metadata_patch: {} })).error).toContain("not both");
  expect(write).not.toHaveBeenCalled();
});

test("metadata patches keep mutation permission and user scoping", async () => {
  for (const [permitted, owner, error] of [[false, "alice", "chat_mutation"], [true, "bob", "user-scoped"]] as const) {
    const { send, read, write } = fixture(permitted, owner);
    expect((await send({ metadata_patch: { value: 1 } })).error).toContain(error);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  }
});

test("metadata patches cannot target a message in a different chat", async () => {
  const { send, write } = fixture();
  expect((await send({ metadata_patch: { value: 1 } }, "other-chat")).error).toBe("Message not found");
  expect(write).not.toHaveBeenCalled();
});

