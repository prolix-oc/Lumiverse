import { afterEach, describe, expect, test } from "bun:test";
import { SwarmUIImageProvider } from "./swarmui";
import type { ImageGenRequest } from "../types";

/**
 * Stub global fetch with a URL-routing recorder so we can assert the body the
 * SwarmUI provider sends to /API/GenerateText2Image. Handles the session
 * handshake and the final image download around the generate call.
 */
function stubFetch() {
  const calls: Array<{ url: string; body: any }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/API/GetNewSession")) {
      return Response.json({ session_id: "sess-1" });
    }
    if (url.endsWith("/API/GenerateText2Image")) {
      return Response.json({ images: ["View/local/raw/out.png"] });
    }
    // Image download
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  }) as typeof fetch;
  return {
    calls,
    genBody() {
      return calls.find((c) => c.url.endsWith("/API/GenerateText2Image"))?.body;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

const BASE = "http://localhost:7801";

function req(parameters: Record<string, any>): ImageGenRequest {
  return { prompt: "a fox", model: "sd_xl", parameters };
}

describe("SwarmUIImageProvider — rawRequestOverride", () => {
  let fetchStub: ReturnType<typeof stubFetch>;

  afterEach(() => fetchStub?.restore());

  test("flat JSON merges into the top-level request body", async () => {
    fetchStub = stubFetch();
    const provider = new SwarmUIImageProvider();
    await provider.generate(
      "",
      BASE,
      req({
        rawRequestOverride: JSON.stringify({
          refinercontrolpercentage: 0.45,
          refinermethod: "PostApply",
          refinerupscale: 1.25,
        }),
      }),
    );

    const body = fetchStub.genBody();
    expect(body.session_id).toBe("sess-1");
    expect(body.prompt).toBe("a fox");
    expect(body.refinercontrolpercentage).toBe(0.45);
    expect(body.refinermethod).toBe("PostApply");
    expect(body.refinerupscale).toBe(1.25);
  });

  test("pasted SwarmUI preset export is unwrapped to its param_map", async () => {
    fetchStub = stubFetch();
    const provider = new SwarmUIImageProvider();
    await provider.generate(
      "",
      BASE,
      req({
        rawRequestOverride: JSON.stringify({
          title: "My Preset",
          author: "someone",
          description: "refiner setup",
          param_map: { refinermethod: "PostApply", refinerupscale: "1.25" },
        }),
      }),
    );

    const body = fetchStub.genBody();
    expect(body.refinermethod).toBe("PostApply");
    expect(body.refinerupscale).toBe("1.25"); // SwarmUI stringifies values server-side
    expect(body.param_map).toBeUndefined();
    expect(body.title).toBeUndefined();
  });

  test("invalid JSON fails generation with a clear error instead of silently dropping", async () => {
    fetchStub = stubFetch();
    const provider = new SwarmUIImageProvider();
    await expect(
      provider.generate("", BASE, req({ rawRequestOverride: '{"refinerupscale": 1.25,}' })),
    ).rejects.toThrow(/not valid JSON/);
    expect(fetchStub.genBody()).toBeUndefined();
  });

  test("non-object JSON is rejected (would otherwise replace the whole body)", async () => {
    fetchStub = stubFetch();
    const provider = new SwarmUIImageProvider();
    await expect(
      provider.generate("", BASE, req({ rawRequestOverride: '["refinerupscale"]' })),
    ).rejects.toThrow(/JSON object/);
  });

  test("protected keys cannot be smuggled through the override", async () => {
    fetchStub = stubFetch();
    const provider = new SwarmUIImageProvider();
    await provider.generate(
      "",
      BASE,
      req({ rawRequestOverride: JSON.stringify({ model: "EVIL", steps: 33 }) }),
    );

    const body = fetchStub.genBody();
    expect(body.model).toBe("sd_xl");
    expect(body.steps).toBe(33); // non-protected override still applies
  });
});
