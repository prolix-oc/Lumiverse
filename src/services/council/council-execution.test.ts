import { describe, expect, test } from "bun:test";
import { selectCouncilContextMessages } from "./council-execution.service";

describe("selectCouncilContextMessages", () => {
  const messages = [
    { id: "1", is_user: true, content: "Older user turn" },
    { id: "2", is_user: false, content: "Older assistant turn" },
    { id: "3", is_user: true, content: "Latest user prompt" },
  ];

  test("preserves the configured window when exclusion is disabled", () => {
    expect(selectCouncilContextMessages(messages, 2, false).map((message) => message.id))
      .toEqual(["2", "3"]);
  });

  test("removes only the latest user prompt from the configured window", () => {
    expect(selectCouncilContextMessages(messages, 3, true).map((message) => message.id))
      .toEqual(["1", "2"]);
  });

  test("does not replace the removed prompt with an older turn", () => {
    expect(selectCouncilContextMessages(messages, 2, true).map((message) => message.id))
      .toEqual(["2"]);
  });
});
