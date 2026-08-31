import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabaseAsync, getDb, initDatabase } from "../src/db/connection";
import * as chatsSvc from "../src/services/chats.service";
import type { AgentSummary } from "../src/types/agents";

const USER_ID = "agent-summary-user";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
  db.run(
    await Bun.file(
      join(import.meta.dir, "..", "src", "db", "migrations", "078_chats_character_id_nullable.sql"),
    ).text(),
  );
}

function makeSummary(
  status: AgentSummary["status"],
  invocationCount = 1,
  errorCodes?: string[],
): AgentSummary {
  return {
    status,
    invocationCount,
    succeededCount: status === "succeeded" ? 1 : 0,
    failedCount: status === "failed" ? 1 : 0,
    cancelledCount: status === "cancelled" ? 1 : 0,
    timedOutCount: status === "timed_out" ? 1 : 0,
    toolCallCount: 2,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...(errorCodes ? { errorCodes } : {}),
  };
}

function createAssistantMessage(extra: Record<string, unknown> = {}) {
  const chat = chatsSvc.createChat(USER_ID, { name: "Agent summary chat" });
  return chatsSvc.createMessage(
    chat.id,
    { is_user: false, name: "Assistant", content: "first", extra },
    USER_ID,
  );
}

describe("AgentSummary swipe-scoped message extras", () => {
  beforeEach(async () => {
    await chatsSvc.waitForChatChunkMaintenance();
    await closeDatabaseAsync();
    initDatabase(":memory:");
    await applyBaseline();
  });

  test("keeps independent summaries across navigation and non-active writes", () => {
    const first = makeSummary("succeeded");
    const second = makeSummary("failed", 2, ["provider_failed"]);
    const message = createAssistantMessage();

    chatsSvc.setSwipeScopedExtra(USER_ID, message.id, 0, { agentActivity: first });
    chatsSvc.addSwipe(USER_ID, message.id, "second");
    chatsSvc.setSwipeScopedExtra(USER_ID, message.id, 1, { agentActivity: second });

    const updatedFirst = makeSummary("cancelled", 3, ["cancelled"]);
    chatsSvc.setSwipeScopedExtra(USER_ID, message.id, 0, { agentActivity: updatedFirst });

    const active = chatsSvc.getMessage(USER_ID, message.id)!;
    expect(active.swipe_id).toBe(1);
    expect(active.extra.agentActivity).toEqual(second);
    expect(active.extra.agentActivityBySwipe).toEqual([updatedFirst, second]);

    const previous = chatsSvc.cycleSwipe(USER_ID, message.id, "left")!;
    expect(previous.swipe_id).toBe(0);
    expect(previous.extra.agentActivity).toEqual(updatedFirst);

    const next = chatsSvc.cycleSwipe(USER_ID, message.id, "right")!;
    expect(next.swipe_id).toBe(1);
    expect(next.extra.agentActivity).toEqual(second);
  });

  test("splices the summary array when deleting a swipe", () => {
    const first = makeSummary("succeeded");
    const second = makeSummary("failed");
    const third = makeSummary("timed_out");
    const message = createAssistantMessage();

    chatsSvc.setSwipeScopedExtra(USER_ID, message.id, 0, { agentActivity: first });
    chatsSvc.addSwipe(USER_ID, message.id, "second");
    chatsSvc.setSwipeScopedExtra(USER_ID, message.id, 1, { agentActivity: second });
    chatsSvc.addSwipe(USER_ID, message.id, "third");
    chatsSvc.setSwipeScopedExtra(USER_ID, message.id, 2, { agentActivity: third });

    const deleted = chatsSvc.deleteSwipe(USER_ID, message.id, 1)!;
    expect(deleted.swipes).toEqual(["first", "third"]);
    expect(deleted.swipe_id).toBe(1);
    expect(deleted.extra.agentActivity).toEqual(third);
    expect(deleted.extra.agentActivityBySwipe).toEqual([first, third]);
  });

  test("omits arrays from light payloads while preserving them on echoed edits", () => {
    const first = makeSummary("succeeded");
    const second = makeSummary("failed");
    const message = createAssistantMessage();
    chatsSvc.setSwipeScopedExtra(USER_ID, message.id, 0, { agentActivity: first });
    chatsSvc.addSwipe(USER_ID, message.id, "second");
    chatsSvc.setSwipeScopedExtra(USER_ID, message.id, 1, { agentActivity: second });

    const light = chatsSvc.listMessages(USER_ID, message.chat_id, { limit: 10, offset: 0 }, { light: true }).data[0]!;
    expect(light.extra.agentActivity).toEqual(second);
    expect(light.extra.agentActivityBySwipe).toBeUndefined();

    chatsSvc.updateMessage(USER_ID, message.id, { extra: light.extra });
    const restored = chatsSvc.cycleSwipe(USER_ID, message.id, "left")!;
    expect(restored.extra.agentActivity).toEqual(first);
  });

  test("normalizes malformed legacy summaries and strips detailed child fields", () => {
    const detailedSummary: Record<string, unknown> = {
      ...makeSummary("succeeded", 1, ["provider_failed", "provider_failed"]),
      childOutput: "must not persist",
      task: "must not persist",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        rawProviderPayload: "must not persist",
      },
    };
    const message = createAssistantMessage({ agentActivity: detailedSummary });

    const stored = getDb()
      .query("SELECT extra FROM messages WHERE id = ?")
      .get(message.id) as { extra: string };
    const storedExtra = JSON.parse(stored.extra) as Record<string, unknown>;
    expect(storedExtra.agentActivity).toBeUndefined();
    expect(storedExtra.agentActivityBySwipe).toEqual([makeSummary("succeeded", 1, ["provider_failed"])]);
    expect(JSON.stringify(storedExtra)).not.toContain("must not persist");

    getDb().query("UPDATE messages SET extra = ? WHERE id = ?").run(
      JSON.stringify({
        agentActivityBySwipe: [
          {
            status: "running",
            invocationCount: 1,
            succeededCount: 0,
            failedCount: 0,
            cancelledCount: 0,
            timedOutCount: 0,
            toolCallCount: 0,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            childOutput: "legacy",
          },
          { ...makeSummary("failed"), invocationCount: -1 },
        ],
      }),
      message.id,
    );
    const malformed = chatsSvc.getMessage(USER_ID, message.id)!;
    expect(malformed.extra.agentActivity).toBeUndefined();
    expect(malformed.extra.agentActivityBySwipe).toBeUndefined();
  });

  test("dedupes and bounds safe error codes while null clearing removes the slot", () => {
    const summary = makeSummary("failed", 2, [
      "provider_failed",
      "provider_failed",
      "tool_failed",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
    ]);
    const message = createAssistantMessage();
    chatsSvc.setSwipeScopedExtra(USER_ID, message.id, 0, { agentActivity: summary });

    const normalized = chatsSvc.getMessage(USER_ID, message.id)!;
    expect((normalized.extra.agentActivity as AgentSummary).errorCodes).toEqual([
      "provider_failed",
      "tool_failed",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
    ]);

    chatsSvc.setSwipeScopedExtra(USER_ID, message.id, 0, { agentActivity: null });
    const cleared = chatsSvc.getMessage(USER_ID, message.id)!;
    expect(cleared.extra.agentActivity).toBeUndefined();
    expect(cleared.extra.agentActivityBySwipe).toBeUndefined();
  });
});
