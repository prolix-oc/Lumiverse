import { describe, expect, test } from "bun:test";
import {
  getProviderList,
  validateProviderCapabilities,
} from "./registry";
import {
  AgentToolCapabilityError,
  assertAgentToolCapability,
  type LlmProvider,
} from "./provider";

const REGISTERED_PROVIDER_NAMES = [
  "openai",
  "anthropic",
  "google",
  "google_vertex",
  "bedrock",
  "openrouter",
  "deepseek",
  "chutes",
  "nanogpt",
  "zai",
  "moonshot",
  "mistral",
  "ai21",
  "perplexity",
  "groq",
  "xai",
  "electronhub",
  "fireworks",
  "pollinations_text",
  "pollinations",
  "siliconflow",
  "infermatic",
  "custom",
] as const;

const REQUIRED_KEYS = [
  "supportsStreaming",
  "toolCalling",
  "requiredToolChoice",
  "nativeToolContinuation",
  "toolContinuationMode",
  "toolsDisabledFinalization",
  "supportsToolFinalization",
] as const;
const NATIVE_CONTINUATION_PROVIDERS: Record<string, true> = {
  openai: true,
  anthropic: true,
  google: true,
  google_vertex: true,
  openrouter: true,
  deepseek: true,
  zai: true,
  moonshot: true,
};

describe("registered provider tool capability contract", () => {
  test("every adapter declares an own, coherent capability set", () => {
    const providers = getProviderList();
    expect(providers.map((provider) => provider.name)).toEqual([...REGISTERED_PROVIDER_NAMES]);

    for (const provider of providers) {
      const capabilities = provider.capabilities;
      for (const key of REQUIRED_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(capabilities, key)).toBe(true);
      }
      expect(typeof capabilities.supportsStreaming).toBe("boolean");
      expect(typeof capabilities.requiredToolChoice).toBe("boolean");
      if (capabilities.requiredToolChoice) expect(capabilities.toolCalling).toBe(true);
      expect(typeof capabilities.toolCalling).toBe("boolean");
      expect(typeof capabilities.nativeToolContinuation).toBe("boolean");
      expect(["native", "legacy", "unsupported"]).toContain(capabilities.toolContinuationMode);
      expect(typeof capabilities.toolsDisabledFinalization).toBe("boolean");
      expect(typeof capabilities.supportsToolFinalization).toBe("boolean");
      expect(capabilities.toolCalling).toBe(capabilities.toolContinuationMode !== "unsupported");
      expect(capabilities.nativeToolContinuation).toBe(
        NATIVE_CONTINUATION_PROVIDERS[provider.name] === true,
      );
      expect(capabilities.toolsDisabledFinalization).toBe(
        capabilities.toolContinuationMode !== "unsupported",
      );
      expect(capabilities.supportsToolFinalization).toBe(capabilities.toolsDisabledFinalization);
      if (capabilities.interleavedThinking === true) {
        expect(capabilities.toolContinuationMode).toBe("native");
      }
    }
  });

  test("required-tool support is explicit on concrete wrapper adapters", () => {
    const capabilities = Object.fromEntries(
      getProviderList().map((provider) => [provider.name, provider.capabilities.requiredToolChoice]),
    );
    expect(capabilities.deepseek).toBe(true);
    expect(capabilities.openrouter).toBe(true);
    expect(capabilities.moonshot).toBe(true);
    expect(capabilities.zai).toBe(true);
    expect(capabilities.custom).toBe(false);
  });

  test("registration validation rejects inherited or implicit declarations", () => {
    const incomplete = {
      name: "incomplete",
      capabilities: {
        parameters: {},
        requiresMaxTokens: false,
        supportsSystemRole: true,
        supportsStreaming: true,
        apiKeyRequired: false,
        modelListStyle: "openai",
      },
    } as unknown as Pick<LlmProvider, "name" | "capabilities">;

    expect(() => validateProviderCapabilities(incomplete)).toThrow(
      "capabilities.toolCalling",
    );
  });

  test("Pollinations text remains explicitly unavailable for agent tools", () => {
    const provider = getProviderList().find((candidate) => candidate.name === "pollinations_text");
    expect(provider?.capabilities.requiredToolChoice).toBe(false);
    expect(provider?.capabilities.toolCalling).toBe(false);
    expect(provider?.capabilities.nativeToolContinuation).toBe(false);
    expect(provider?.capabilities.toolContinuationMode).toBe("unsupported");
    expect(provider?.capabilities.toolsDisabledFinalization).toBe(false);
  });

  test("preflight preserves the exact unsupported tool capability", () => {
    const base = getProviderList().find((candidate) => candidate.name === "openai")!;
    const expectCode = (
      capabilities: LlmProvider["capabilities"],
      code: AgentToolCapabilityError["code"],
    ) => {
      try {
        assertAgentToolCapability({ capabilities });
        throw new Error("expected capability preflight to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentToolCapabilityError);
        expect((error as AgentToolCapabilityError).code).toBe(code);
      }
    };

    expectCode(
      { ...base.capabilities, toolCalling: false },
      "provider_tool_calling_unsupported",
    );
    expectCode(
      { ...base.capabilities, toolContinuationMode: "unsupported", nativeToolContinuation: false, toolsDisabledFinalization: false },
      "provider_tool_continuation_unsupported",
    );
    expectCode(
      { ...base.capabilities, toolsDisabledFinalization: false },
      "provider_tool_finalization_unsupported",
    );
  });
});
