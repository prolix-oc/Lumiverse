import { describe, expect, test } from "bun:test";
import { selectSummarizationMessages } from "./summarization-prompts.service";

describe("selectSummarizationMessages", () => {
  const messages = Array.from({ length: 12 }, (_, index) => index + 1);

  test("selects context immediately before the protected trailing buffer", () => {
    expect(selectSummarizationMessages(messages, 4, 2)).toEqual([7, 8, 9, 10]);
  });

  test("uses the newest context when lag is disabled", () => {
    expect(selectSummarizationMessages(messages, 4)).toEqual([9, 10, 11, 12]);
  });

  test("returns no messages when the lag protects the whole chat", () => {
    expect(selectSummarizationMessages(messages, 4, 20)).toEqual([]);
  });
});
