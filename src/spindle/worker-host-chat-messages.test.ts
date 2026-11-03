import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as chats from "../services/chats.service";
import * as characters from "../services/characters.service";
import { WorkerHost } from "./worker-host";

type ReadMessage = {
  id: string;
  index_in_chat: number;
  content: string;
  swipe_id: number;
  swipes: Array<string | null>;
  extra?: Record<string, unknown>;
  hidden: boolean;
  metadata?: Record<string, unknown>;
};

const owner = "owner";
let chatId: string;
let ids: string[];

beforeEach(async () => {
  closeDatabase(); initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
  chatId = chats.createChat(owner, {}).id;
  ids = Array.from({ length: 5 }, (_, i) =>
    chats.createMessage(chatId, { is_user: i % 2 === 0, name: i % 2 === 0 ? "User" : "Character", content: `message ${i}` }, owner).id,
  );
  chats.updateMessage(owner, ids[1], {
    swipes: ["swipe a", "swipe b", "swipe c"],
    swipe_id: 1,
    extra: {
      hidden: true,
      reasoningBySwipe: ["thought a", "thought b", "thought c"],
      spindle_metadata: { ext_alpha: { n: 1 }, ext_beta: { n: 2 } },
    },
    skipChunkRebuild: true,
  });
});
afterEach(closeDatabase);

function createHost(identifier: string, permitted = true) {
  const host = new WorkerHost(identifier, { identifier, name: identifier } as SpindleManifest, {
    id: identifier, identifier, name: identifier,
    version: "0.0.0", author: "", description: "", github: "", homepage: "",
    permissions: [], granted_permissions: [], enabled: true, installed_at: 0, updated_at: 0,
    has_frontend: false, has_backend: false, status: "stopped",
    metadata: { install_scope: "user", installed_by_user_id: owner },
  } satisfies ExtensionInfo);
  const internal = host as unknown as {
    hasPermission(permission: string): boolean;
    handleMessage(message: unknown): void;
    runtime: { mode: string; pid: null; postMessage(message: unknown): void; terminate(): void };
  };
  internal.hasPermission = (permission) => permitted && permission === "chat_mutation";
  const call = (message: Record<string, unknown>) => {
    const { promise, resolve } = Promise.withResolvers<{ result?: unknown; error?: string }>();
    internal.runtime = { mode: "worker", pid: null, postMessage: (response) => resolve(response as { result?: unknown; error?: string }), terminate() {} };
    internal.handleMessage({ requestId: "request", chatId, ...message });
    return promise;
  };
  return {
    call,
    read: async (options?: unknown): Promise<ReadMessage[]> => {
      const response = await call({ type: "chat_get_messages", options });
      if (response.error) throw new Error(response.error);
      return response.result as ReadMessage[];
    },
    readError: async (options: unknown) => (await call({ type: "chat_get_messages", options })).error,
    update: async (messageId: string, patch: Record<string, unknown>) => {
      const response = await call({ type: "chat_update_message", messageId, patch });
      if (response.error) throw new Error(response.error);
    },
    updateError: async (messageId: string, patch: Record<string, unknown>) =>
      (await call({ type: "chat_update_message", messageId, patch })).error,
  };
}

const storedMetadata = (messageId: string) => chats.getMessage(owner, messageId)!.extra.spindle_metadata;

test("backend message append preserves explicit identity and legacy defaults", async () => {
  const character = characters.createCharacter(owner, { name: "Character" });
  const host = createHost("ext_alpha");
  const response = await host.call({ type: "chat_append_message", message: {
    role: "assistant", content: "", name: character.name, characterId: character.id, metadata: { run: "run" },
  } });
  expect(response.error).toBeUndefined();
  const message = chats.getMessage(owner, (response.result as { id: string }).id)!;
  expect(message.name).toBe(character.name);
  expect(message.extra.character_id).toBe(character.id);
  expect(message.extra.spindle_metadata).toEqual({ run: "run" });
  const legacy = await host.call({ type: "chat_append_message", message: { role: "assistant", content: "reply" } });
  expect(chats.getMessage(owner, (legacy.result as { id: string }).id)!.name).toBe("Assistant");
});

test("backend message identity cannot refer to another user's character or bypass chat permissions", async () => {
  const other = characters.createCharacter("other-user", { name: "Private character" });
  const message = { role: "assistant", content: "", name: "Character", characterId: other.id };
  const count = chats.getMessages(owner, chatId).length;
  expect((await createHost("ext_alpha").call({ type: "chat_append_message", message })).error).toContain("Invalid message character");
  expect((await createHost("ext_alpha", false).call({ type: "chat_append_message", message })).error).toContain("permission");
  expect(chats.getMessages(owner, chatId)).toHaveLength(count);
});

test("default read keeps every swipe, the full extra bag and every extension's metadata", async () => {
  const messages = await createHost("ext_alpha").read();
  expect(messages.map((m) => m.content)).toEqual(["message 0", "swipe b", "message 2", "message 3", "message 4"]);
  const message = messages[1];
  expect(message.swipes).toEqual(["swipe a", "swipe b", "swipe c"]);
  expect(message.extra).toMatchObject({ hidden: true, reasoning: "thought b", reasoningBySwipe: ["thought a", "thought b", "thought c"] });
  expect(message.extra).not.toHaveProperty("spindle_metadata");
  expect(message.metadata).toEqual({ ext_alpha: { n: 1 }, ext_beta: { n: 2 } });
  expect(message.hidden).toBe(true);
  expect(messages[0].hidden).toBe(false);
  expect(messages[0].metadata).toBeUndefined();
});

test("scoped writes from two extensions both survive", async () => {
  await createHost("ext_alpha").update(ids[0], { ownMetadata: { step: "a" } });
  await createHost("ext_beta").update(ids[0], { ownMetadata: { step: "b" } });
  expect(storedMetadata(ids[0])).toEqual({ ext_alpha: { step: "a" }, ext_beta: { step: "b" } });
});

test("a scoped write keeps another extension's earlier whole-bag write", async () => {
  await createHost("ext_beta").update(ids[0], { metadata: { ext_beta: { whole: true }, shared: 1 } });
  await createHost("ext_alpha").update(ids[0], { ownMetadata: [1, 2] });
  expect(storedMetadata(ids[0])).toEqual({ ext_beta: { whole: true }, shared: 1, ext_alpha: [1, 2] });
});

test("null removes only the caller's entry", async () => {
  const alpha = createHost("ext_alpha");
  await alpha.update(ids[1], { ownMetadata: null });
  expect(storedMetadata(ids[1])).toEqual({ ext_beta: { n: 2 } });
  await alpha.update(ids[2], { ownMetadata: { n: 3 } });
  await alpha.update(ids[2], { ownMetadata: null });
  expect(storedMetadata(ids[2])).toBeUndefined();
});

test("a host-owned identifier has no own metadata entry", async () => {
  const host = createHost("preset_contexts");
  expect(await host.updateError(ids[0], { ownMetadata: {} })).toContain("host-owned");
  expect((await host.read({ ownMetadataOnly: true }))[1].metadata).toBeUndefined();
});

test("tail and page reads return the requested window in chat order", async () => {
  const host = createHost("ext_alpha");
  const indexes = async (options: unknown) => (await host.read(options)).map((m) => m.index_in_chat);
  expect(await indexes({ tail: 2 })).toEqual([3, 4]);
  expect(await indexes({ tail: 1000 })).toEqual([0, 1, 2, 3, 4]);
  expect(await indexes({ limit: 2 })).toEqual([0, 1]);
  expect(await indexes({ limit: 2, offset: 3 })).toEqual([3, 4]);
  expect(await indexes({ limit: 2, offset: 5 })).toEqual([]);
});

test("read options are validated", async () => {
  const host = createHost("ext_alpha");
  for (const options of [{ limit: 0 }, { limit: 1001 }, { tail: 1.5 }, { tail: "2" }, { limit: 2, offset: -1 }]) {
    expect(await host.readError(options)).toContain("must be an integer");
  }
  expect(await host.readError({ tail: 2, limit: 2 })).toContain("cannot be combined");
  expect(await host.readError({ offset: 2 })).toContain("requires options.limit");
  expect(await host.readError({ light: "yes" })).toContain("must be a boolean");
  expect(await host.readError("tail")).toContain("must be an object");
});

test("light keeps only the active swipe text and drops per-swipe arrays", async () => {
  const [, message] = await createHost("ext_alpha").read({ light: true });
  expect(message.swipes).toEqual([null, "swipe b", null]);
  expect(message.extra).toMatchObject({ hidden: true, reasoning: "thought b" });
  expect(message.extra).not.toHaveProperty("reasoningBySwipe");
});

test("omitting extra keeps the hidden flag", async () => {
  const messages = await createHost("ext_alpha").read({ includeExtra: false });
  expect(messages[1]).not.toHaveProperty("extra");
  expect(messages.map((m) => m.hidden)).toEqual([false, true, false, false, false]);
  expect(messages[1].metadata).toEqual({ ext_alpha: { n: 1 }, ext_beta: { n: 2 } });
});

test("own metadata only returns the caller's entry", async () => {
  const messages = await createHost("ext_alpha").read({ ownMetadataOnly: true });
  expect(messages[1].metadata).toEqual({ ext_alpha: { n: 1 } });
  expect(messages[0].metadata).toBeUndefined();
  expect((await createHost("ext_gamma").read({ ownMetadataOnly: true }))[1].metadata).toBeUndefined();
});

test("lean options combine", async () => {
  const messages = await createHost("ext_beta").read({ tail: 4, light: true, includeExtra: false, ownMetadataOnly: true });
  expect(messages.map((m) => m.index_in_chat)).toEqual([1, 2, 3, 4]);
  expect(messages[0]).toMatchObject({ swipes: [null, "swipe b", null], hidden: true, metadata: { ext_beta: { n: 2 } } });
  expect(messages[0]).not.toHaveProperty("extra");
});

test("scoped writes compose with metadata patches and preserve host swipe contexts", async () => {
  const contexts = [{ source: "preset-a" }, { source: "preset-b" }, null];
  const host = createHost("ext_alpha");
  await host.update(ids[1], { metadata_patch: { preset_contexts: contexts, shared: "latest" } });
  await host.update(ids[1], {
    metadata_patch: { ext_beta: { updated: true } },
    ownMetadata: { own: true },
    swipe_id: 2,
    skipChunkRebuild: true,
  });
  expect(storedMetadata(ids[1])).toEqual({
    ext_alpha: { own: true }, ext_beta: { updated: true }, preset_contexts: contexts, shared: "latest",
  });
  await host.update(ids[1], { ownMetadata: null });
  expect(storedMetadata(ids[1])).toEqual({ ext_beta: { updated: true }, preset_contexts: contexts, shared: "latest" });
  await host.update(ids[1], { metadata: { replacement: true }, ownMetadata: ["own"] });
  expect(storedMetadata(ids[1])).toEqual({ replacement: true, ext_alpha: ["own"] });
});

test("lean reads and scoped writes retain permission, account and message boundaries", async () => {
  const denied = createHost("ext_alpha", false);
  expect(await denied.readError({ light: true })).toContain("chat_mutation");
  expect(await denied.updateError(ids[1], { ownMetadata: "denied" })).toContain("chat_mutation");
  const otherChat = chats.createChat("other-user", {}).id;
  const otherMessage = chats.createMessage(otherChat, { is_user: true, name: "Other", content: "private" }, "other-user").id;
  const host = createHost("ext_alpha");
  expect((await host.call({ type: "chat_get_messages", chatId: otherChat, options: { light: true } })).error).toContain("user-scoped");
  expect((await host.call({ type: "chat_update_message", chatId: otherChat, messageId: otherMessage, patch: { ownMetadata: "denied" } })).error).toContain("user-scoped");
  expect(await host.updateError(otherMessage, { ownMetadata: "denied" })).toBe("Message not found");
  expect(await host.readError({ tail: 1, offset: 0 })).toContain("cannot be combined");
  for (const options of [{ limit: NaN }, { tail: Infinity }, { limit: 1, offset: Number.MAX_SAFE_INTEGER + 1 }, { includeExtra: 0 }, { ownMetadataOnly: "yes" }]) {
    expect(await host.readError(options)).toBeString();
  }
  expect(chats.getMessage("other-user", otherMessage)!.extra.spindle_metadata).toBeUndefined();
  expect(storedMetadata(ids[1])).toEqual({ ext_alpha: { n: 1 }, ext_beta: { n: 2 } });
});
