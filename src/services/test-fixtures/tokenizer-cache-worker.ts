import { TokenizerResourceCache } from "../tokenizer-resource-cache";

self.onmessage = (event: MessageEvent<{ directory: string; owner: string }>) => {
  const cache = new TokenizerResourceCache({ ...event.data, fetchText: async () => {
    postMessage("locked");
    return new Promise<string>(() => {});
  } });
  void cache.read("https://example.com/model", "v1").catch(() => {});
};
