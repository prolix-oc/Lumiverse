import { afterEach, expect, spyOn, test } from "bun:test";
import * as chats from "../services/chats.service";
import * as pruning from "../services/wi-state-prune.service";
import { WorkerHostContentApi } from "./worker-host-content-api";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
function fixture(permitted: boolean | readonly string[] = true) {
  const chat = { id: "chat", metadata: { updated: true }, name: "Chat", character_id: "char", created_at: 1, updated_at: 1 };
  const update = spyOn(chats, "compareAndSetChatMetadata").mockReturnValue(chat);
  const prune = spyOn(pruning, "pruneOrphanedWiState").mockImplementation((_user, value) => value);
  spies.push(update, prune);
  let response: any;
  const api = new WorkerHostContentApi({ manifest: { identifier: "test" },
    hasPermission: permission => typeof permitted === "boolean" ? permitted : permitted.includes(permission),
    resolveEffectiveUserId: user => user ?? "alice", enforceScopedUser: user => { if (user !== "alice") throw new Error("Wrong user"); },
    postResponse: value => { response = value; },
  });
  return { update, prune, send: (input: unknown, user?: string) => {
    api.handleChatsCompareAndSetMetadata("request", "chat", input, user); return response;
  } };
}

test("conditional metadata RPC cannot inspect message state without chat_mutation", () => {
  const f = fixture(["chats"]);
  const response = f.send({
    expected_metadata: {},
    metadata: {},
    expected_last_message_id: "reply",
    expected_message: { id: "reply", swipe_id: 0, swipes: ["private text"], metadata: {} },
  });
  expect(response.error).toContain("chat_mutation");
  expect(f.update).not.toHaveBeenCalled();
  expect(f.prune).not.toHaveBeenCalled();
});

test("conditional metadata RPC validates guards before mutating", () => {
  const f = fixture();
  const base = { metadata: {}, expected_metadata: {} };
  for (const input of [null, {}, { ...base, metadata: [] }, { ...base, expected_metadata: null },
    { ...base, expected_last_message_id: 1 }, { ...base, expected_message: null },
    ...[NaN, -1, 1.2, "0"].map(swipe_id => ({ ...base, expected_message: { id: "m", swipe_id, swipes: ["A"], metadata: {} } })),
    { ...base, expected_message: { id: "m", swipe_id: 0, swipes: [1], metadata: {} } },
  ]) expect(f.send(input).error).toBeDefined();
  expect(f.update).not.toHaveBeenCalled();
});

test("conditional metadata RPC preserves permissions, user scope and conflict results", () => {
  const denied = fixture(false);
  expect(denied.send({ expected_metadata: {}, metadata: {} }).error).toContain("permission");
  expect(denied.update).not.toHaveBeenCalled();
  denied.update.mockRestore(); denied.prune.mockRestore();
  const allowed = fixture();
  expect(allowed.send({ expected_metadata: {}, metadata: {} }, "bob").error).toContain("Wrong user");
  expect(allowed.update).not.toHaveBeenCalled();
  allowed.update.mockReturnValue(null);
  expect(allowed.send({ expected_metadata: {}, metadata: {} }).result).toBeNull();
  expect(allowed.prune).not.toHaveBeenCalled();
});

test("conditional metadata changes prune removed world-book state only on success", () => {
  const f = fixture();
  expect(f.send({ expected_metadata: { chat_world_book_ids: ["removed"] }, metadata: {} }).result.id).toBe("chat");
  expect(f.prune).toHaveBeenCalledTimes(1);
  expect(f.update.mock.calls[0]!.slice(0, 2)).toEqual(["alice", "chat"]);
});
