import { describe, expect, test } from "bun:test";
import { normalizeGuidedGenerations } from "./guided-generations";

const baseGuide = {
  id: "guide-1",
  name: "Stay concise",
  content: "Keep the reply brief.",
  position: "system",
  mode: "persistent",
  enabled: false,
};

describe("guided generation automatic activation", () => {
  test.each([
    ["connection", "connectionProfileId", "connection-1"],
    ["chat", "chatId", "chat-1"],
    ["character", "characterId", "character-1"],
  ] as const)("activates a guide for a matching %s", (scope, contextKey, id) => {
    const guides = normalizeGuidedGenerations(
      [{ ...baseGuide, autoEnable: { scope, id } }],
      { [contextKey]: id },
    );

    expect(guides).toHaveLength(1);
    expect(guides[0].enabled).toBe(true);
  });

  test("does not activate a guide outside its bound context", () => {
    const guides = normalizeGuidedGenerations(
      [{ ...baseGuide, autoEnable: { scope: "chat", id: "chat-1" } }],
      { chatId: "chat-2" },
    );

    expect(guides).toEqual([]);
  });

  test("manual activation continues to work regardless of context", () => {
    const guides = normalizeGuidedGenerations(
      [{ ...baseGuide, enabled: true, autoEnable: { scope: "chat", id: "chat-1" } }],
      { chatId: "chat-2" },
    );

    expect(guides).toHaveLength(1);
  });

  test("ignores malformed automatic activation rules", () => {
    const guides = normalizeGuidedGenerations(
      [{ ...baseGuide, autoEnable: { scope: "workspace", id: "workspace-1" } }],
      { chatId: "workspace-1" },
    );

    expect(guides).toEqual([]);
  });
});
