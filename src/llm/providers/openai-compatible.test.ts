import { describe, expect, test } from "bun:test";
import { OpenAICompatibleProvider } from "./openai-compatible";

class TestOpenAICompatibleProvider extends OpenAICompatibleProvider {
  readonly name = "test";
  readonly displayName = "Test";
  readonly defaultUrl = "https://example.com";
  readonly capabilities = {
    parameters: {},
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: false,
    modelListStyle: "openai" as const,
  };

  public inspect(content: unknown, reasoning: unknown) {
    return this.splitMirroredReasoning(content, reasoning);
  }
}

describe("OpenAICompatibleProvider reasoning mirroring", () => {
  const provider = new TestOpenAICompatibleProvider();

  test("drops content when it exactly mirrors reasoning", () => {
    expect(provider.inspect("planning", "planning")).toEqual({
      content: "",
      reasoning: "planning",
    });
  });

  test("drops content when it only differs by surrounding whitespace", () => {
    expect(provider.inspect("  planning\n", "planning")).toEqual({
      content: "",
      reasoning: "planning",
    });
  });

  test("preserves normal visible content when it differs from reasoning", () => {
    expect(provider.inspect("Answer", "planning")).toEqual({
      content: "Answer",
      reasoning: "planning",
    });
  });
});
