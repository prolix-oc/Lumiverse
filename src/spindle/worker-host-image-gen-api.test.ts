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

