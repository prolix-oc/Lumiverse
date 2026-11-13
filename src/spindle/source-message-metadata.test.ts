import { describe, expect, test } from "bun:test";
import type { LlmMessage } from "../llm/types";
import {
  __sourceMessageMetadataTest,
  getSourceMessageId,
  getSourceIndexInChat,
  isChatHistoryMessage,
} from "../services/prompt-assembly.service";
import {
  collectSourceMessageMetadata,
  getSourceMessageMetadata,
  projectSourceMessageMetadata,
  restoreSourceMessageMetadata,
  stampSourceMessageMetadata,
} from "./source-message-metadata";

function historyMessage(
  id: string,
  index: number,
  metadata: Record<string, unknown>,
): LlmMessage {
  const message = {
    role: "user",
    content: id,
    __chatHistorySource: true,
    __sourceMessageId: id,
    __sourceIndexInChat: index,
  } as LlmMessage;
  stampSourceMessageMetadata(message, metadata);
  return message;
}

describe("source message metadata", () => {
  test("keeps metadata paired with the preserved source id when user turns merge", () => {
    const messages = [
      historyMessage("first", 1, { owner: "first" }),
      historyMessage("second", 2, { owner: "second" }),
    ];

    const count =
      __sourceMessageMetadataTest.mergeConsecutiveUserMessages(
        messages,
        0,
        messages.length,
      );

    expect(count).toBe(1);
    expect(getSourceMessageId(messages[0])).toBe("first");
    expect(getSourceMessageMetadata(messages[0])).toEqual({ owner: "first" });
  });

  test("projects only permission-gated metadata and restores it between interceptors", () => {
    const source = historyMessage("source", 1, { shelf: "abc" });
    const metadataById = collectSourceMessageMetadata([source]);

    const allowed = projectSourceMessageMetadata(source, true, true);
    expect(allowed.sourceMessageMetadata).toEqual({ shelf: "abc" });
    expect(allowed).not.toHaveProperty("__sourceMessageMetadata");

    const denied = projectSourceMessageMetadata(
      {
        ...source,
        sourceMessageMetadata: { forged: true },
      } as never,
      true,
      false,
    );
    expect(denied).not.toHaveProperty("sourceMessageMetadata");
    expect(denied).not.toHaveProperty("__sourceMessageMetadata");

    const returned = {
      role: "user",
      content: "source",
      __isChatHistory: true,
      sourceMessageId: "source",
    };
    restoreSourceMessageMetadata([returned], metadataById);
    expect(getSourceMessageMetadata(returned)).toEqual({ shelf: "abc" });

    const forged = {
      role: "user",
      content: "forged",
      sourceMessageId: "unknown",
      __sourceMessageMetadata: { forged: true },
    };
    restoreSourceMessageMetadata([forged], metadataById);
    expect(getSourceMessageMetadata(forged)).toBeUndefined();

    expect(
      projectSourceMessageMetadata(
        { role: "user", content: "untagged" },
        true,
        true,
      ).sourceMessageMetadata,
    ).toEqual({});
  });

  test("restores authentic provenance on reconstructed DTOs and clears forged provenance", () => {
    const source = historyMessage("source", 7, { shelf: "authentic" });
    const metadataById = collectSourceMessageMetadata([source]);
    const reconstructed = {
      role: "user",
      content: "reconstructed",
      __isChatHistory: true,
      sourceMessageId: "source",
      sourceIndexInChat: 999,
      sourceMessageMetadata: { forged: true },
      __chatHistorySource: true,
      __sourceMessageId: "forged-internal",
      __sourceIndexInChat: 998,
      __sourceMessageMetadata: { forged: true },
    };

    restoreSourceMessageMetadata([reconstructed], metadataById);

    expect(isChatHistoryMessage(reconstructed as LlmMessage)).toBe(true);
    expect(getSourceMessageId(reconstructed as LlmMessage)).toBe("source");
    expect(getSourceIndexInChat(reconstructed as LlmMessage)).toBe(7);
    expect(getSourceMessageMetadata(reconstructed)).toEqual({
      shelf: "authentic",
    });

    const forged = {
      role: "user",
      content: "forged",
      __isChatHistory: true,
      sourceMessageId: "unknown",
      sourceIndexInChat: 999,
      sourceMessageMetadata: { forged: true },
      __chatHistorySource: true,
      __sourceMessageId: "unknown",
      __sourceIndexInChat: 999,
      __sourceMessageMetadata: { forged: true },
    };

    restoreSourceMessageMetadata([forged], metadataById);

    expect(isChatHistoryMessage(forged as LlmMessage)).toBe(false);
    expect(getSourceMessageId(forged as LlmMessage)).toBeUndefined();
    expect(getSourceIndexInChat(forged as LlmMessage)).toBeUndefined();
    expect(getSourceMessageMetadata(forged)).toBeUndefined();
    expect(forged).not.toHaveProperty("__isChatHistory");
    expect(forged).not.toHaveProperty("sourceMessageId");
    expect(forged).not.toHaveProperty("sourceIndexInChat");
    expect(forged).not.toHaveProperty("sourceMessageMetadata");
  });
});
