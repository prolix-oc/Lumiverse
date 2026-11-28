import { expect, test } from "bun:test";
import type { ImageProvider } from "../image-gen/provider";
import {
  applyDataUrlInclusion,
  WorkerHostImageGenApi,
  supportsWebSocketPreviewStreaming,
} from "./worker-host-image-gen-api";

function makeProvider(overrides: Partial<ImageProvider> = {}): ImageProvider {
  return {
    name: "test",
    displayName: "Test provider",
    capabilities: {
      parameters: {},
      apiKeyRequired: false,
      modelListStyle: "static",
      defaultUrl: "https://example.test",
    },
    async generate() {
      return { imageDataUrl: "data:image/png;base64,", model: "test", provider: "test" };
    },
    async validateKey() {
      return true;
    },
    async listModels() {
      return [];
    },
    ...overrides,
  };
}

test("only explicitly WebSocket-capable providers can expose preview streams", () => {
  const streamOnly = makeProvider({
    async *generateStream() {
      return { imageDataUrl: "data:image/png;base64,", model: "test", provider: "test" };
    },
  });
  const capabilityOnly = makeProvider({
    capabilities: {
      ...makeProvider().capabilities,
      websocketPreviewStreaming: { previews: true, status: true },
    },
  });
  const supported = makeProvider({
    capabilities: {
      ...makeProvider().capabilities,
      websocketPreviewStreaming: { previews: true, status: true },
    },
    async *generateStream() {
      return { imageDataUrl: "data:image/png;base64,", model: "test", provider: "test" };
    },
  });

  expect(supportsWebSocketPreviewStreaming(streamOnly)).toBe(false);
  expect(supportsWebSocketPreviewStreaming(capabilityOnly)).toBe(false);
  expect(supportsWebSocketPreviewStreaming(supported)).toBe(true);
});

test("streaming requests retain the image_gen permission gate", async () => {
  const messages: unknown[] = [];
  const api = new WorkerHostImageGenApi({
    extensionIdentifier: "preview_test",
    hasPermission: () => false,
    resolveEffectiveUserId: () => "user-1",
    enforceScopedUser: () => undefined,
    post: (message) => messages.push(message),
  });

  await api.handleGenerateStream("request-1", { prompt: "test" });

  expect(messages).toEqual([
    expect.objectContaining({
      type: "image_gen_stream_error",
      requestId: "request-1",
      error: expect.stringContaining("image_gen"),
    }),
  ]);
});


test("applyDataUrlInclusion keeps the base64 payload by default", () => {
  const result = {
    imageDataUrl: "data:image/png;base64,AAAA",
    imageId: "img-1",
    imageUrl: "/api/v1/image-gen/results/img-1",
    model: "test",
    provider: "test",
  };
  expect(applyDataUrlInclusion(result, true)).toEqual(result);
});

test("applyDataUrlInclusion strips the base64 payload when opted out", () => {
  const result = {
    imageDataUrl: "data:image/png;base64,AAAA",
    imageId: "img-1",
    imageUrl: "/api/v1/image-gen/results/img-1",
    model: "test",
    provider: "test",
  };
  expect(applyDataUrlInclusion(result, false)).toEqual({
    imageId: "img-1",
    imageUrl: "/api/v1/image-gen/results/img-1",
    model: "test",
    provider: "test",
  });
});

test("applyDataUrlInclusion does not mutate the source result", () => {
  const result = {
    imageDataUrl: "data:image/png;base64,AAAA",
    imageId: "img-1",
    imageUrl: "/api/v1/image-gen/results/img-1",
  };
  const stripped = applyDataUrlInclusion(result, false);
  expect(stripped).not.toBe(result);
  expect(result.imageDataUrl).toBe("data:image/png;base64,AAAA");
  expect("imageDataUrl" in stripped).toBe(false);
});


test("Swarm host trace separates provider completion, delayed persistence and done delivery", async () => {
  const messages: any[] = [];
  const logs: any[] = [];
  const originalInfo = console.info;
  let releasePersist!: () => void;
  const persistGate = new Promise<void>(resolve => { releasePersist = resolve; });
  let persistStarted!: () => void;
  const enteredPersist = new Promise<void>(resolve => { persistStarted = resolve; });
  const api = new WorkerHostImageGenApi({
    extensionIdentifier: "preview_test",
    hasPermission: () => true,
    resolveEffectiveUserId: () => "private-user",
    enforceScopedUser: () => undefined,
    post: message => messages.push(message),
  });
  const provider = makeProvider({
    name: "swarmui",
    capabilities: { ...makeProvider().capabilities, websocketPreviewStreaming: { previews: true, status: true } },
    async *generateStream(_key, _url, request) {
      request.onProviderTrace?.({ action: "image-frame", atMs: Date.now(), elapsedMs: 10 });
      yield { step: 92, totalSteps: 100, preview: "data:image/png;base64,PRIVATE" };
      request.onProviderTrace?.({ action: "batch-complete-frame", atMs: Date.now(), elapsedMs: 20 });
      return { imageDataUrl: "data:image/png;base64,PRIVATE", provider: "swarmui", model: "test" };
    },
  });
  // Stub only the host services (connection resolution and persistence). The
  // actual WorkerHostImageGenApi stream loop and its message contract run here.
  Object.assign(api, {
    resolveGeneration: async () => ({ provider, apiKey: "private-token", connection: { api_url: "private-url" }, request: { prompt: "private-prompt", model: "test", parameters: {} } }),
    persistResult: async () => { persistStarted(); await persistGate; return { imageId: "image-1", provider: "swarmui" }; },
  });
  console.info = (...args: unknown[]) => {
    if (args[0] === "[image-gen:swarm-timing]") logs.push(JSON.parse(String(args[1])));
    // Also prove an unavailable log sink cannot change the stream outcome.
    throw new Error("diagnostic sink unavailable");
  };
  try {
    const running = api.handleGenerateStream("request-1", {});
    await enteredPersist;
    expect(messages.map(m => m.event?.type)).toEqual(["status", "preview"]);
    expect(logs.map(e => e.action)).toEqual(["host-resolved", "image-frame", "batch-complete-frame", "host-provider-returned", "host-persist-start"]);
    releasePersist();
    await running;
    expect(messages.map(m => m.event?.type)).toEqual(["status", "preview", "done"]);
    expect(messages.at(-1)?.event.result.imageId).toBe("image-1");
    expect(logs.slice(-2).map(e => e.action)).toEqual(["host-persist-complete", "host-done-posted"]);
    expect(logs.at(-1)?.imageId).toBe("image-1");
    expect(new Set(logs.map(e => e.traceId)).size).toBe(1);
    expect(JSON.stringify(logs).includes("PRIVATE")).toBe(false);
    expect(JSON.stringify(logs).includes("private-")).toBe(false);
  } finally {
    releasePersist();
    console.info = originalInfo;
  }
});
