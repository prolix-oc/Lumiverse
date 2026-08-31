import type { LlmProvider } from "./provider";
import { OpenAIProvider } from "./providers/openai";
import { AnthropicProvider } from "./providers/anthropic";
import { GoogleProvider } from "./providers/google";
import { OpenRouterProvider } from "./providers/openrouter";
import { DeepSeekProvider } from "./providers/deepseek";
import { ChutesProvider } from "./providers/chutes";
import { NanoGPTProvider } from "./providers/nanogpt";
import { ZAIProvider } from "./providers/zai";
import { MoonshotProvider } from "./providers/moonshot";
import { MistralProvider } from "./providers/mistral";
import { AI21Provider } from "./providers/ai21";
import { PerplexityProvider } from "./providers/perplexity";
import { GroqProvider } from "./providers/groq";
import { XAIProvider } from "./providers/xai";
import { ElectronHubProvider } from "./providers/electronhub";
import { FireworksProvider } from "./providers/fireworks";
import { PollinationsProvider } from "./providers/pollinations";
import { PollinationsTextProvider } from "./providers/pollinations-text";
import { SiliconFlowProvider } from "./providers/siliconflow";
import { InfermaticProvider } from "./providers/infermatic";
import { CustomProvider } from "./providers/custom";
import { GoogleVertexProvider } from "./providers/google-vertex";
import { BedrockProvider } from "./providers/bedrock";

const providers = new Map<string, LlmProvider>();

const REQUIRED_TOOL_CAPABILITY_KEYS = [
  "supportsStreaming",
  "toolCalling",
  "requiredToolChoice",
  "nativeToolContinuation",
  "toolContinuationMode",
  "toolsDisabledFinalization",
  "supportsToolFinalization",
] as const;

/**
 * Validate the closed provider/tool contract at registration time. Checking
 * own properties is deliberate: a base class or prototype must not silently
 * supply an adapter's feature capability.
 */
export function validateProviderCapabilities(provider: Pick<LlmProvider, "name" | "capabilities">): void {
  const capabilities = provider.capabilities;
  for (const key of REQUIRED_TOOL_CAPABILITY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(capabilities, key)) {
      throw new Error(`Provider "${provider.name}" must declare capabilities.${key}`);
    }
  }

  if (typeof capabilities.supportsStreaming !== "boolean") {
    throw new Error(`Provider "${provider.name}" has invalid capabilities.supportsStreaming`);
  }
  if (typeof capabilities.toolCalling !== "boolean") {
    throw new Error('Provider "' + provider.name + '" has invalid capabilities.toolCalling');
  }
  if (typeof capabilities.requiredToolChoice !== "boolean") {
    throw new Error('Provider "' + provider.name + '" has invalid capabilities.requiredToolChoice');
  }
  if (capabilities.requiredToolChoice && !capabilities.toolCalling) {
    throw new Error('Provider "' + provider.name + '" cannot require a tool without tool calling');
  }
  if (typeof capabilities.nativeToolContinuation !== "boolean") {
    throw new Error('Provider "' + provider.name + '" has invalid capabilities.nativeToolContinuation');
  }
  if (
    capabilities.toolContinuationMode !== "native" &&
    capabilities.toolContinuationMode !== "legacy" &&
    capabilities.toolContinuationMode !== "unsupported"
  ) {
    throw new Error(`Provider "${provider.name}" has invalid capabilities.toolContinuationMode`);
  }
  if (typeof capabilities.toolsDisabledFinalization !== "boolean") {
    throw new Error(`Provider "${provider.name}" has invalid capabilities.toolsDisabledFinalization`);
  }
  if (typeof capabilities.supportsToolFinalization !== "boolean") {
    throw new Error(`Provider "${provider.name}" has invalid capabilities.supportsToolFinalization`);
  }
  if (
    (capabilities.toolCalling && capabilities.toolContinuationMode === "unsupported") ||
    (!capabilities.toolCalling && capabilities.toolContinuationMode !== "unsupported")
  ) {
    throw new Error(`Provider "${provider.name}" has incoherent tool calling capabilities`);
  }
  if (
    capabilities.nativeToolContinuation !==
    (capabilities.toolContinuationMode === "native")
  ) {
    throw new Error(`Provider "${provider.name}" has incoherent native continuation capabilities`);
  }
  if (
    (capabilities.toolContinuationMode === "unsupported") !==
    (!capabilities.toolsDisabledFinalization)
  ) {
    throw new Error(`Provider "${provider.name}" has incoherent finalization capabilities`);
  }
  if (capabilities.supportsToolFinalization !== capabilities.toolsDisabledFinalization) {
    throw new Error(`Provider "${provider.name}" has incoherent finalization compatibility`);
  }
  if (capabilities.interleavedThinking === true && !capabilities.nativeToolContinuation) {
    throw new Error(`Provider "${provider.name}" cannot interleave thinking without native continuation`);
  }
}

export function registerProvider(provider: LlmProvider): void {
  validateProviderCapabilities(provider);
  providers.set(provider.name, provider);
}

export function getProvider(name: string): LlmProvider | undefined {
  return providers.get(name);
}

export function listProviders(): string[] {
  return [...providers.keys()];
}

export function getProviderList(): LlmProvider[] {
  return [...providers.values()];
}

// Register built-in providers
registerProvider(new OpenAIProvider());
registerProvider(new AnthropicProvider());
registerProvider(new GoogleProvider());
registerProvider(new GoogleVertexProvider());
registerProvider(new BedrockProvider());
registerProvider(new OpenRouterProvider());
registerProvider(new DeepSeekProvider());
registerProvider(new ChutesProvider());
registerProvider(new NanoGPTProvider());
registerProvider(new ZAIProvider());
registerProvider(new MoonshotProvider());
registerProvider(new MistralProvider());
registerProvider(new AI21Provider());
registerProvider(new PerplexityProvider());
registerProvider(new GroqProvider());
registerProvider(new XAIProvider());
registerProvider(new ElectronHubProvider());
registerProvider(new FireworksProvider());
registerProvider(new PollinationsTextProvider());
registerProvider(new PollinationsProvider());
registerProvider(new SiliconFlowProvider());
registerProvider(new InfermaticProvider());
registerProvider(new CustomProvider());
