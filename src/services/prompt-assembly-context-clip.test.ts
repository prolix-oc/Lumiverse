import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "path";

import type { LlmMessage } from "../llm/types";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as charactersSvc from "./characters.service";
import * as chatsSvc from "./chats.service";
import * as presetsSvc from "./presets.service";
import * as embeddingsSvc from "./embeddings.service";
import {
  assemblePrompt,
  clipToContextBudget,
  isChatHistoryMessage,
} from "./prompt-assembly.service";
import { prefetchAssemblyData } from "./prompt-assembly-prefetch";
import type { PromptBlock } from "../types/preset";
import { readMessageRevision } from "../utils/message-revision";

describe("clipToContextBudget", () => {
  test("surfaces when fixed prompt overhead leaves no room for chat history", async () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "S".repeat(3000) },
      { role: "user", content: "U".repeat(200) },
      { role: "assistant", content: "A".repeat(200) },
    ];

    (messages[1] as any).__chatHistorySource = true;
    (messages[2] as any).__chatHistorySource = true;

    const stats = await clipToContextBudget(messages, null, 1200, 200);

    expect(stats.enabled).toBe(true);
    expect(stats.fixedOverBudget).toBe(true);
    expect(stats.remainingHistoryBudget).toBeLessThan(0);
    expect(stats.messagesDropped).toBe(2);
    expect(stats.chatHistoryTokensAfter).toBe(0);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    expect(isChatHistoryMessage(messages[0])).toBe(false);
  });

  test("clips only history before a protected context anchor", async () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "A ".repeat(5_000) },
      { role: "assistant", content: "B ".repeat(200) },
      { role: "user", content: "C ".repeat(200) },
    ];

    for (const message of messages) (message as any).__chatHistorySource = true;
    (messages[1] as any).__contextAnchorProtected = true;
    (messages[2] as any).__contextAnchorProtected = true;

    const stats = await clipToContextBudget(messages, null, 1_200, 200);

    expect(stats.anchorActive).toBe(true);
    expect(stats.anchorOverflow).not.toBe(true);
    expect(stats.protectedHistoryTokens).toBeGreaterThan(0);
    expect(stats.remainingBeforeAnchor).toBeGreaterThanOrEqual(0);
    expect(stats.messagesDropped).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => (message as any).__contextAnchorProtected)).toBe(true);
  });

  test("always excludes history before a context anchor, even when it fits", async () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "before anchor" },
      { role: "assistant", content: "anchor" },
      { role: "user", content: "after anchor" },
    ];

    for (const message of messages) (message as any).__chatHistorySource = true;
    (messages[1] as any).__contextAnchorProtected = true;
    (messages[2] as any).__contextAnchorProtected = true;

    const stats = await clipToContextBudget(messages, null, 16_000, 200);

    expect(stats.anchorActive).toBe(true);
    expect(stats.anchorOverflow).not.toBe(true);
    expect(stats.messagesDropped).toBe(1);
    expect(messages.map((message) => message.content)).toEqual(["anchor", "after anchor"]);
  });

  test("drops pre-anchor history without trimming an anchor tail that cannot fit", async () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "A ".repeat(1_000) },
      { role: "assistant", content: "B ".repeat(2_000) },
      { role: "user", content: "C ".repeat(2_000) },
    ];

    for (const message of messages) (message as any).__chatHistorySource = true;
    (messages[1] as any).__contextAnchorProtected = true;
    (messages[2] as any).__contextAnchorProtected = true;

    const stats = await clipToContextBudget(messages, null, 1_200, 200);

    expect(stats.anchorActive).toBe(true);
    expect(stats.anchorOverflow).toBe(true);
    expect(stats.messagesDropped).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => (message as any).__contextAnchorProtected)).toBe(true);
  });

  test("applies a context anchor when automatic context clipping is disabled", async () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "before anchor" },
      { role: "assistant", content: "anchor" },
      { role: "user", content: "after anchor" },
    ];

    for (const message of messages) (message as any).__chatHistorySource = true;
    (messages[1] as any).__contextAnchorProtected = true;
    (messages[2] as any).__contextAnchorProtected = true;

    const stats = await clipToContextBudget(messages, null, null, null);

    expect(stats.enabled).toBe(false);
    expect(stats.anchorActive).toBe(true);
    expect(stats.messagesDropped).toBe(1);
    expect(messages.map((message) => message.content)).toEqual(["anchor", "after anchor"]);
  });
});

// ── Edit-and-Send history cutoff (assemblePrompt seam) ─────────────────────
//
// Drives the REAL assembly against a real in-memory DB and prefetched data, so
// the assertions observe the assembled chat history rather than a helper return.

const EA_USER = "edit-send-assembly-user";

function makeBlock(overrides: Partial<PromptBlock>): PromptBlock {
  return {
    id: crypto.randomUUID(),
    name: "block",
    content: "",
    role: "system",
    enabled: true,
    position: "pre_history",
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    ...overrides,
  };
}

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

interface EditSendFixture {
  chatId: string;
  presetId: string;
  editedUserMessageId: string;
  editedRevision: number;
}

/**
 * Seed U1/A1/U2/A2 with optional trailing sentinels. Returns the id + revision
 * of the selected user turn U1, which the caller passes as the committed edit.
 */
function seedBranchFalseChat(opts: { trailingSentinels?: string[] } = {}): EditSendFixture {
  const character = charactersSvc.createCharacter(EA_USER, { name: "Nyra" });
  const chat = chatsSvc.createChat(EA_USER, { character_id: character.id });
  const preset = presetsSvc.createPreset(EA_USER, {
    name: "edit-send cutoff preset",
    provider: "openai",
    parameters: { context_length: 8192, max_tokens: 256 },
    prompts: {},
    prompt_order: [
      makeBlock({ content: "Preamble" }),
      makeBlock({ name: "Chat History", marker: "chat_history" }),
    ],
  });

  const add = (isUser: boolean, content: string) =>
    chatsSvc.createMessage(
      chat.id,
      { is_user: isUser, name: isUser ? "User" : "Nyra", content },
      EA_USER,
    );

  const u1 = add(true, "U1-edited-target");
  add(false, "A1-after-u1");
  const u2 = add(true, "U2-after-a1");
  add(false, "A2-after-u2");
  for (const sentinel of opts.trailingSentinels ?? []) add(false, sentinel);

  const revision = getDb()
    .query("SELECT revision FROM messages WHERE id = ?")
    .get(u1.id) as { revision: number };

  return {
    chatId: chat.id,
    presetId: preset.id,
    editedUserMessageId: u1.id,
    editedRevision: revision.revision,
  };
}

function historyContents(result: { messages: LlmMessage[] }): string[] {
  return result.messages
    .filter((m) => isChatHistoryMessage(m))
    .map((m) => String(m.content));
}

describe("assemblePrompt edit-and-send history cutoff", () => {
  let deleteEmbeddingsSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
    deleteEmbeddingsSpy = spyOn(embeddingsSvc, "deleteChatChunkEmbeddings").mockResolvedValue(undefined);
  });

  afterEach(() => {
    deleteEmbeddingsSpy.mockRestore();
    closeDatabase();
  });

  function commitFixture(swipes: string[]) {
    const fixture = seedBranchFalseChat();
    const message = chatsSvc.updateMessage(EA_USER, fixture.editedUserMessageId, {
      swipes,
      swipe_id: 0,
    });
    const committed = chatsSvc.editAndSend(EA_USER, fixture.chatId, {
      messageId: fixture.editedUserMessageId,
      content: "Committed user text",
      expectedVersion: readMessageRevision(message)!,
      requestId: crypto.randomUUID(),
      branchChatOnEditAndSend: false,
    });
    if (committed.status !== "ok") throw new Error(committed.error);
    return {
      userId: EA_USER,
      chatId: fixture.chatId,
      generationType: "swipe" as const,
      presetId: fixture.presetId,
      excludeMessageId: committed.payload.immediateAssistantId!,
      editAndSendContext: committed.payload.generationCursor.editAndSendContext!,
    };
  }

  test.each(["add", "update", "cycle", "delete"] as const)(
    "rejects committed context after active user text changes via swipe %s",
    async (operation) => {
      const ctx = commitFixture(["Original user text", "Alternative user text"]);
      const id = ctx.editAndSendContext.editedUserMessageId;
      switch (operation) {
        case "add": chatsSvc.addSwipe(EA_USER, id, "Replacement after commit"); break;
        case "update": chatsSvc.updateSwipe(EA_USER, id, 0, "Replacement after commit"); break;
        case "cycle": chatsSvc.cycleSwipe(EA_USER, id, "right"); break;
        case "delete": chatsSvc.deleteSwipe(EA_USER, id, 0); break;
      }
      expect(readMessageRevision(chatsSvc.getMessage(EA_USER, id)))
        .toBe(ctx.editAndSendContext.committedRevision + 1);
      await expect(assemblePrompt(ctx)).rejects.toThrow(
        "Edit-and-Send message revision has changed since it was committed",
      );
    },
  );

  test.each(["add identical", "update identical", "update inactive", "cycle identical", "delete identical", "delete inactive"] as const)(
    "keeps committed context valid when active user text is unchanged: %s",
    async (operation) => {
      const ctx = commitFixture(["Original user text", "Committed user text"]);
      const id = ctx.editAndSendContext.editedUserMessageId;
      switch (operation) {
        case "add identical": chatsSvc.addSwipe(EA_USER, id, "Committed user text"); break;
        case "update identical": chatsSvc.updateSwipe(EA_USER, id, 0, "Committed user text"); break;
        case "update inactive": chatsSvc.updateSwipe(EA_USER, id, 1, "Inactive replacement"); break;
        case "cycle identical": chatsSvc.cycleSwipe(EA_USER, id, "right"); break;
        case "delete identical": chatsSvc.deleteSwipe(EA_USER, id, 0); break;
        case "delete inactive": chatsSvc.deleteSwipe(EA_USER, id, 1); break;
      }
      expect(readMessageRevision(chatsSvc.getMessage(EA_USER, id)))
        .toBe(ctx.editAndSendContext.committedRevision);
      expect(historyContents(await assemblePrompt(ctx))).toEqual(["Committed user text"]);
    },
  );

  test("cuts history inclusively at the edited user turn (U1) and drops later turns", async () => {
    const fixture = seedBranchFalseChat();

    const result = await assemblePrompt({
      userId: EA_USER,
      chatId: fixture.chatId,
      generationType: "normal",
      presetId: fixture.presetId,
      editAndSendContext: {
        editedUserMessageId: fixture.editedUserMessageId,
        committedRevision: fixture.editedRevision,
      },
    } as any);

    const contents = historyContents(result as any).join("\n");
    expect(contents).toContain("U1-edited-target");
    expect(contents).not.toContain("A1-after-u1");
    expect(contents).not.toContain("U2-after-a1");
    expect(contents).not.toContain("A2-after-u2");
  });

  test("MessageLimit still strips later sentinels but keeps the edited U1", async () => {
    // Even with a MessageLimit that would normally slide the window forward, the
    // Edit-and-Send cutoff runs first, so post-edit sentinels never survive.
    const fixture = seedBranchFalseChat({
      trailingSentinels: ["SENTINEL-3", "SENTINEL-4", "SENTINEL-5"],
    });
    const db = getDb();
    db.run(
      `INSERT OR REPLACE INTO settings (key, value, user_id) VALUES (?, ?, ?)`,
      ["summarization", JSON.stringify({ messageLimitEnabled: true, messageLimitCount: 2 }), EA_USER],
    );

    const result = await assemblePrompt({
      userId: EA_USER,
      chatId: fixture.chatId,
      generationType: "normal",
      presetId: fixture.presetId,
      editAndSendContext: {
        editedUserMessageId: fixture.editedUserMessageId,
        committedRevision: fixture.editedRevision,
      },
    } as any);

    const contents = historyContents(result as any).join("\n");
    expect(contents).toContain("U1-edited-target");
    expect(contents).not.toContain("A1-after-u1");
    expect(contents).not.toContain("U2-after-a1");
    expect(contents).not.toContain("A2-after-u2");
    for (const sentinel of ["SENTINEL-3", "SENTINEL-4", "SENTINEL-5"]) {
      expect(contents).not.toContain(sentinel);
    }
  });

  test("branch-true control: a different edited turn cuts at ITS position", async () => {
    const fixture = seedBranchFalseChat();
    // Select U2 instead: history must keep U1/A1/U2 and drop A2.
    const u2 = getDb()
      .query("SELECT id FROM messages WHERE chat_id = ? AND content = ?")
      .get(fixture.chatId, "U2-after-a1") as { id: string };

    const result = await assemblePrompt({
      userId: EA_USER,
      chatId: fixture.chatId,
      generationType: "normal",
      presetId: fixture.presetId,
      editAndSendContext: {
        editedUserMessageId: u2.id,
        committedRevision: fixture.editedRevision,
      },
    } as any);

    const contents = historyContents(result as any).join("\n");
    expect(contents).toContain("U1-edited-target");
    expect(contents).toContain("A1-after-u1");
    expect(contents).toContain("U2-after-a1");
    expect(contents).not.toContain("A2-after-u2");
  });

  test("ordinary generation without edit-and-send context keeps the full history", async () => {
    const fixture = seedBranchFalseChat();

    const result = await assemblePrompt({
      userId: EA_USER,
      chatId: fixture.chatId,
      generationType: "normal",
      presetId: fixture.presetId,
    } as any);

    const contents = historyContents(result as any).join("\n");
    expect(contents).toContain("U1-edited-target");
    expect(contents).toContain("A1-after-u1");
    expect(contents).toContain("U2-after-a1");
    expect(contents).toContain("A2-after-u2");
  });

  test("intervening edit after the snapshot is rejected at assembly (no fallback)", async () => {
    const fixture = seedBranchFalseChat();
    // The user edited again after this request was queued: bump the live
    // revision past the committed one.
    getDb().query("UPDATE messages SET revision = revision + 1 WHERE id = ?").run(
      fixture.editedUserMessageId,
    );

    await expect(
      assemblePrompt({
        userId: EA_USER,
        chatId: fixture.chatId,
        generationType: "normal",
        presetId: fixture.presetId,
        editAndSendContext: {
          editedUserMessageId: fixture.editedUserMessageId,
          committedRevision: fixture.editedRevision,
        },
      } as any),
    ).rejects.toThrow("Edit-and-Send message revision has changed since it was committed");
  });

  test("missing edited target is rejected at assembly, not silently uncapped", async () => {
    const fixture = seedBranchFalseChat();
    getDb().query("DELETE FROM messages WHERE id = ?").run(fixture.editedUserMessageId);

    await expect(
      assemblePrompt({
        userId: EA_USER,
        chatId: fixture.chatId,
        generationType: "normal",
        presetId: fixture.presetId,
        editAndSendContext: {
          editedUserMessageId: fixture.editedUserMessageId,
          committedRevision: fixture.editedRevision,
        },
      } as any),
    ).rejects.toThrow("Edit-and-Send target message is no longer part of this chat");
  });

  test("valid prefetched snapshot is still rejected when the live row advanced after prefetch", async () => {
    const fixture = seedBranchFalseChat();
    const ctx = {
      userId: EA_USER,
      chatId: fixture.chatId,
      generationType: "normal" as const,
      presetId: fixture.presetId,
      editAndSendContext: {
        editedUserMessageId: fixture.editedUserMessageId,
        committedRevision: fixture.editedRevision,
      },
    };

    // Capture a REAL prefetched snapshot while the committed revision is still
    // current: its `messages` carry the old-but-valid revision R.
    const prefetched = await prefetchAssemblyData(ctx as any);
    const snapshotSelected = prefetched.messages.find(
      (m) => m.id === fixture.editedUserMessageId,
    ) as { revision?: unknown } | undefined;
    expect(snapshotSelected?.revision).toBe(fixture.editedRevision);

    // The competing edit lands AFTER prefetch but BEFORE assembly consumes it.
    getDb()
      .query("UPDATE messages SET revision = revision + 1 WHERE id = ?")
      .run(fixture.editedUserMessageId);

    // The snapshot alone would pass; the live DB re-read must reject.
    await expect(
      assemblePrompt({ ...ctx, prefetched } as any),
    ).rejects.toThrow("Edit-and-Send message revision has changed since it was committed");
  });
});
