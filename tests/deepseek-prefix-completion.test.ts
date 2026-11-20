import { describe, expect, test } from "bun:test";
import { DeepSeekProvider } from "../src/llm/providers/deepseek";
import type { GenerationRequest, LlmMessage } from "../src/llm/types";

class TestDeepSeek extends DeepSeekProvider {
  public flatten(message: LlmMessage) {
    return this.flattenForChat(message);
  }

  public build(request: GenerationRequest, stream = true) {
    return this.buildBody(request, stream);
  }

  public requestUrl(apiUrl: string, request: GenerationRequest) {
    return this.chatCompletionsUrl(apiUrl, request);
  }
}

const provider = new TestDeepSeek();

describe("DeepSeek Chat Prefix Completion", () => {
  test("maps an internal assistant partial to DeepSeek's prefix flag", () => {
    const body = provider.build({
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "Write quick sort code" },
        { role: "assistant", content: "```python\n", partial: true },
      ],
    });

    expect(body.messages).toEqual([
      { role: "user", content: "Write quick sort code" },
      { role: "assistant", content: "```python\n", prefix: true },
    ]);
  });

  test("supports a reasoning-only prefix for thinking mode", () => {
    expect(
      provider.flatten({
        role: "assistant",
        content: "",
        partial: true,
        reasoning_content: "We need to solve this step by step. ",
      }),
    ).toEqual([
      {
        role: "assistant",
        content: "",
        prefix: true,
        reasoning_content: "We need to solve this step by step. ",
      },
    ]);
  });

  test("does not add prefix or replay reasoning on an ordinary assistant turn", () => {
    expect(
      provider.flatten({
        role: "assistant",
        content: "A completed reply",
        reasoning_content: "private prior reasoning",
      }),
    ).toEqual([{ role: "assistant", content: "A completed reply" }]);
  });

  test("routes official prefix requests through the beta endpoint only", () => {
    const ordinary: GenerationRequest = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "Hello" }],
    };
    const prefixed: GenerationRequest = {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi", partial: true },
      ],
    };

    expect(provider.requestUrl("", ordinary)).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
    expect(provider.requestUrl("", prefixed)).toBe(
      "https://api.deepseek.com/beta/chat/completions",
    );
    expect(
      provider.requestUrl("https://api.deepseek.com/beta", prefixed),
    ).toBe("https://api.deepseek.com/beta/chat/completions");
  });

  test("preserves custom proxy routing for prefix requests", () => {
    const request: GenerationRequest = {
      model: "deepseek-v4-pro",
      messages: [{ role: "assistant", content: "Hi", partial: true }],
    };

    expect(provider.requestUrl("https://proxy.example/v1", request)).toBe(
      "https://proxy.example/v1/chat/completions",
    );
  });
});
