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
  const host = new WorkerHost("variables-test", { identifier: "variables-test", name: "Variables test" } as SpindleManifest, {
    id: "variables-test", identifier: "variables-test", name: "Variables test", version: "0.0.0", author: "",
    description: "", github: "", homepage: "", permissions: [], granted_permissions: [], enabled: true,
    installed_at: 0, updated_at: 0, has_frontend: false, has_backend: false, status: "stopped",
    metadata: { install_scope: "user", installed_by_user_id: "alice" },
  } satisfies ExtensionInfo);
  const internal = host as any;
  internal.hasPermission = (permission: string) => permitted && ["chat_mutation", "chats"].includes(permission);
  internal.getChatOwnerId = () => owner;
  const send = (patch: unknown, chatId = "chat") => new Promise<any>(resolve => {
    internal.runtime = { mode: "worker", pid: null, postMessage: resolve, terminate() {} };
    internal.handleMessage({ type: "chat_update_message", requestId: "request", chatId, messageId: "message", patch });
  });
  const variables = (input: unknown) => new Promise<any>(resolve => {
    internal.runtime = { mode: "worker", pid: null, postMessage: resolve, terminate() {} };
    internal.handleMessage({ type: "chat_set_swipe_variables", requestId: "request", chatId: "chat", messageId: "message", input });
  });
  return { send, variables, read, write, current };
}

test("swipe variable RPC validates state and enforces both permissions and user scope", async () => {
  const save = spyOn(chats, "setSwipeVariables").mockReturnValue(true); spies.push(save);
  const f = fixture();
  const values = { global: {}, chat: { count: "1" } };
  const input = { expected_variables: values, expected_revision: null, expected_swipes: ["A"], variables: [values] };
  for (const invalid of [null, {}, { ...input, expected_revision: undefined }, { ...input, variables: [] },
    { ...input, variables: [{ global: {}, chat: { count: 1 } }] }, { ...input, expected_swipes: [1] }]) {
    expect((await f.variables(invalid)).error).toContain("Invalid swipe variable");
  }
  expect(save).not.toHaveBeenCalled();
  expect((await fixture(false).variables(input)).error).toContain("permissions");
  expect((await fixture(true, "bob").variables(input)).error).toContain("user-scoped");
  expect(save).not.toHaveBeenCalled();
  expect((await f.variables(input)).result).toBe(true);
  expect(save.mock.calls[0]).toEqual(["alice", "chat", "message", input]);
});
