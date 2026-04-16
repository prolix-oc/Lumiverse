import type { TtsProvider } from "./provider";

const providers = new Map<string, TtsProvider>();

export function registerTtsProvider(provider: TtsProvider): void {
  providers.set(provider.name, provider);
}

export function getTtsProvider(name: string): TtsProvider | undefined {
  return providers.get(name);
}

export function listTtsProviders(): string[] {
  return [...providers.keys()];
}

export function getTtsProviderList(): TtsProvider[] {
  return [...providers.values()];
}
