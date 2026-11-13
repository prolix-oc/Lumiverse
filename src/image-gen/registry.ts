import type { ImageProvider } from "./provider";

const providers = new Map<string, ImageProvider>();

export function registerImageProvider(provider: ImageProvider): void {
  providers.set(provider.name, provider);
}

export function getImageProvider(name: string): ImageProvider | undefined {
  return providers.get(name);
}

export function listImageProviders(): string[] {
  return [...providers.keys()];
}

export function getImageProviderList(): ImageProvider[] {
  return [...providers.values()];
}
