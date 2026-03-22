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
import { SiliconFlowProvider } from "./providers/siliconflow";
import { CustomProvider } from "./providers/custom";

const providers = new Map<string, LlmProvider>();

export function registerProvider(provider: LlmProvider): void {
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
registerProvider(new PollinationsProvider());
registerProvider(new SiliconFlowProvider());
registerProvider(new CustomProvider());
