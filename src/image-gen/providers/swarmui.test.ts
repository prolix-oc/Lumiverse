import { afterEach, describe, expect, test } from "bun:test";
import { SwarmUIImageProvider } from "./swarmui";
import { ComfyUIImageProvider } from "./comfyui";
import { openWebSocket } from "./ws-helpers";
import { ProviderRequestError } from "../../utils/provider-errors";
import type { ImageGenRequest } from "../types";

/**
 * Stub global fetch with a URL-routing recorder so we can assert the body the
 * SwarmUI provider sends to /API/GenerateText2Image. Handles the session
 * handshake and the final image download around the generate call.
 */
type StubFetch = {
  calls: Array<{ url: string; body: unknown }>;
  genBody(): Record<string, unknown> | undefined;
  restore(): void;
};

function stubFetch(): StubFetch {
  const calls: Array<{ url: string; body: unknown }> = [];
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
      const body = calls.find((call) => call.url.endsWith("/API/GenerateText2Image"))?.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
      return body as Record<string, unknown>;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

function generatedRequestBody(fetchStub: StubFetch): Record<string, unknown> {
  const body = fetchStub.genBody();
  if (!body) throw new Error("Expected a generated request body");
  return body;
}

let baseCounter = 0;

function uniqueBase(): string {
  baseCounter += 1;
  return `http://swarmui-test-${baseCounter}.invalid`;
}

function req(parameters: Record<string, unknown>): ImageGenRequest {
  return { prompt: "a fox", model: "sd_xl", parameters };
}

type FetchCall = {
  url: string;
  body: unknown;
  cookie: string | null;
  signal: AbortSignal | null;
};

type InstalledFetch = {
  calls: FetchCall[];
  restore(): void;
};

function installFetch(
  respond: (call: FetchCall) => Response | Promise<Response>,
): InstalledFetch {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      cookie: new Headers(init?.headers).get("cookie"),
      signal: init?.signal ?? null,
    };
    calls.push(call);
    return await respond(call);
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function captureProviderError(request: Promise<unknown>): Promise<ProviderRequestError> {
  try {
    await request;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRequestError);
    return error as ProviderRequestError;
  }
  throw new Error("Expected the provider request to fail");
}

function modelListBody(call: FetchCall): Record<string, unknown> {
  if (!call.body || typeof call.body !== "object" || Array.isArray(call.body)) {
    throw new Error("Expected a JSON object request body");
  }
  return call.body as Record<string, unknown>;
}


function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type TestWebSocketListener = (event: Event | MessageEvent) => void;

class TestWebSocket {
  static autoOpen = true;
  static instances: TestWebSocket[] = [];

  readonly url: string;
  readonly headers: Record<string, string> | undefined;
  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Set<TestWebSocketListener>>();

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = options?.headers;
    TestWebSocket.instances.push(this);
    if (TestWebSocket.autoOpen) queueMicrotask(() => this.open());
  }

  addEventListener(type: string, listener: TestWebSocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<TestWebSocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: TestWebSocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }

  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data } as MessageEvent);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }

  private emit(type: string, event: Event | MessageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function trackAbortListeners(signal: AbortSignal): {
  active: Set<EventListenerOrEventListenerObject>;
  restore(): void;
} {
  const active = new Set<EventListenerOrEventListenerObject>();
  const originalAdd = signal.addEventListener;
  const originalRemove = signal.removeEventListener;
  signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "abort" && listener) {
      active.add(listener as EventListenerOrEventListenerObject);
    }
    originalAdd.call(signal, type, listener as EventListenerOrEventListenerObject, options);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === "abort" && listener) {
      active.delete(listener as EventListenerOrEventListenerObject);
    }
    originalRemove.call(signal, type, listener as EventListenerOrEventListenerObject, options);
  }) as typeof signal.removeEventListener;
  return {
    active,
    restore() {
      signal.addEventListener = originalAdd;
      signal.removeEventListener = originalRemove;
    },
  };
}


type ModelListQuery = { path: string; depth: number; subtype: string };
type ModelListInternals = {
  fetchModelList(
    apiKey: string,
    apiUrl: string,
    query: ModelListQuery,
  ): Promise<Array<{ id: string; label: string }>>;
};

type SessionInternals = {
  getSession(baseUrl: string, token?: string, signal?: AbortSignal): Promise<string>;
  sessions: Map<string, { promise: Promise<string>; expiresAt: number }>;
  pendingSessions: Map<string, Promise<string>>;
};


describe("SwarmUIImageProvider — rawRequestOverride", () => {
  let fetchStub: StubFetch;

  afterEach(() => fetchStub?.restore());

  test("flat JSON merges into the top-level request body", async () => {
    fetchStub = stubFetch();
    const provider = new SwarmUIImageProvider();
    await provider.generate(
      "",
      uniqueBase(),
      req({
        rawRequestOverride: JSON.stringify({
          refinercontrolpercentage: 0.45,
          refinermethod: "PostApply",
          refinerupscale: 1.25,
        }),
      }),
    );

    const body = generatedRequestBody(fetchStub);
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
      uniqueBase(),
      req({
        rawRequestOverride: JSON.stringify({
          title: "My Preset",
          author: "someone",
          description: "refiner setup",
          param_map: { refinermethod: "PostApply", refinerupscale: "1.25" },
        }),
      }),
    );

    const body = generatedRequestBody(fetchStub);
    expect(body.refinermethod).toBe("PostApply");
    expect(body.refinerupscale).toBe("1.25"); // SwarmUI stringifies values server-side
    expect(body.param_map).toBeUndefined();
    expect(body.title).toBeUndefined();
  });

  test("invalid JSON fails generation with a clear error instead of silently dropping", async () => {
    fetchStub = stubFetch();
    const provider = new SwarmUIImageProvider();
    await expect(
      provider.generate("", uniqueBase(), req({ rawRequestOverride: '{"refinerupscale": 1.25,}' })),
    ).rejects.toThrow(/not valid JSON/);
    expect(fetchStub.genBody()).toBeUndefined();
  });

  test("non-object JSON is rejected (would otherwise replace the whole body)", async () => {
    fetchStub = stubFetch();
    const provider = new SwarmUIImageProvider();
    await expect(
      provider.generate("", uniqueBase(), req({ rawRequestOverride: '["refinerupscale"]' })),
    ).rejects.toThrow(/JSON object/);
  });

  test("protected keys cannot be smuggled through the override", async () => {
    fetchStub = stubFetch();
    const provider = new SwarmUIImageProvider();
    await provider.generate(
      "",
      uniqueBase(),
      req({ rawRequestOverride: JSON.stringify({ model: "EVIL", steps: 33 }) }),
    );

    const body = generatedRequestBody(fetchStub);
    expect(body.model).toBe("sd_xl");
    expect(body.steps).toBe(33); // non-protected override still applies
  });

  test("an optional UNet selection overrides the connection model", async () => {
    fetchStub = stubFetch();
    const response = await new SwarmUIImageProvider().generate(
      "",
      uniqueBase(),
      req({ unet: "flux/flux1-dev.safetensors" }),
    );

    expect(generatedRequestBody(fetchStub).model).toBe("flux/flux1-dev.safetensors");
    expect(response.model).toBe("flux/flux1-dev.safetensors");
  });
});

describe("SwarmUIImageProvider — model discovery", () => {
  let fetchStub: InstalledFetch;

  afterEach(() => fetchStub?.restore());

  test("loads UNet choices from SwarmUI's unified Stable-Diffusion inventory", async () => {
    const base = uniqueBase();
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        return Response.json({ session_id: "session-unet" });
      }
      if (call.url === `${base}/API/ListModels`) {
        return Response.json({ files: [{ name: "flux/flux1-dev.safetensors" }] });
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    const models = await new SwarmUIImageProvider().listModelsBySubtype("", base, "unets");

    expect(models).toEqual([{ id: "flux/flux1-dev.safetensors", label: "flux1-dev" }]);
    const listCall = fetchStub.calls.find((call) => call.url.endsWith("/API/ListModels"));
    expect(listCall?.body).toEqual({
      session_id: "session-unet",
      path: "",
      depth: 10,
      subtype: "Stable-Diffusion",
    });
  });

  test("lists canonical nested LoRA paths with the exact request body", async () => {
    const base = uniqueBase();
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        return Response.json({ session_id: "session-0" });
      }
      if (call.url === `${base}/API/ListModels`) {
        return Response.json({
          folders: ["nested"],
          files: [
            { name: "nested/artist/model.safetensors" },
            "compatibility/legacy.ckpt",
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    const models = await new SwarmUIImageProvider().listModelsBySubtype("", base, "loras");

    expect(models).toEqual([
      { id: "nested/artist/model.safetensors", label: "model" },
      { id: "compatibility/legacy.ckpt", label: "legacy" },
    ]);
    const sessionCall = fetchStub.calls.find((call) => call.url.endsWith("/API/GetNewSession"));
    const listCall = fetchStub.calls.find((call) => call.url.endsWith("/API/ListModels"));
    expect(sessionCall?.body).toEqual({});
    expect(sessionCall?.cookie).toBeNull();
    expect(listCall?.body).toEqual({
      session_id: "session-0",
      path: "",
      depth: 10,
      subtype: "LoRA",
    });
  });

  test("surfaces HTTP-200 GetNewSession errors before reading session_id", async () => {
    const base = uniqueBase();
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        return Response.json({
          error: "Invalid or unauthorized.",
          error_id: "unauthorized",
        });
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    const error = await captureProviderError(
      new SwarmUIImageProvider().listModelsBySubtype("", base, "loras"),
    );

    expect(error).toMatchObject({
      provider: "SwarmUI",
      operation: "session request",
      code: "unauthorized",
      detail: "Invalid or unauthorized.",
    });
    expect(fetchStub.calls).toHaveLength(1);
  });

  test("surfaces HTTP-200 ListModels errors instead of returning an empty library", async () => {
    const base = uniqueBase();
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        return Response.json({ session_id: "session-0" });
      }
      if (call.url === `${base}/API/ListModels`) {
        return Response.json({ error: "Invalid sub-type." });
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    const error = await captureProviderError(
      new SwarmUIImageProvider().listModelsBySubtype("", base, "loras"),
    );

    expect(error).toMatchObject({
      provider: "SwarmUI",
      operation: "model listing",
      code: "Invalid sub-type.",
      detail: "Invalid sub-type.",
    });
  });

  test("normalizes HTTP-200 generation error IDs", async () => {
    const whitespaceBase = uniqueBase();
    const malformedBase = uniqueBase();
    const oversizedBase = uniqueBase();
    const errorsByBase = new Map<string, unknown>([
      [whitespaceBase, { error: "Generation rejected.", error_id: " generation_rejected " }],
      [malformedBase, { error: "Generation rejected.", error_id: { unexpected: true } }],
      [oversizedBase, { error: "Generation rejected.", error_id: "x".repeat(600) }],
    ]);

    fetchStub = installFetch((call) => {
      if (call.url.endsWith("/API/GetNewSession")) {
        return Response.json({ session_id: "session-0" });
      }
      if (call.url.endsWith("/API/GenerateText2Image")) {
        const base = call.url.slice(0, call.url.lastIndexOf("/API/"));
        return Response.json(errorsByBase.get(base));
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    const provider = new SwarmUIImageProvider();
    const whitespace = await captureProviderError(provider.generate("", whitespaceBase, req({})));
    expect(whitespace).toMatchObject({
      operation: "image generate",
      code: "generation_rejected",
      detail: "Generation rejected.",
    });

    const malformed = await captureProviderError(provider.generate("", malformedBase, req({})));
    expect(malformed).toMatchObject({
      operation: "image generate",
      code: "Generation rejected.",
      detail: "Generation rejected.",
    });

    const oversized = await captureProviderError(provider.generate("", oversizedBase, req({})));
    expect(oversized.code).toBe(`${"x".repeat(497)}...`);
    expect(oversized.code).toHaveLength(500);
    expect(oversized.detail).toBe("Generation rejected.");
  });

  test("rejects malformed model-listing response shapes", async () => {
    const invalidResponses: Array<{ label: string; data: unknown }> = [
      { label: "null", data: null },
      { label: "array", data: [] },
      { label: "missing files", data: {} },
      { label: "null files", data: { files: null } },
      { label: "non-array files", data: { files: {} } },
      { label: "empty object file", data: { files: [{}] } },
      { label: "blank object name", data: { files: [{ name: "" }] } },
      { label: "whitespace object name", data: { files: [{ name: "  " }] } },
      { label: "blank string file", data: { files: [""] } },
      { label: "numeric file", data: { files: [42] } },
    ];
    const responsesByBase = new Map<string, unknown>();
    const bases = invalidResponses.map(() => uniqueBase());
    for (const [index, base] of bases.entries()) {
      responsesByBase.set(base, invalidResponses[index]!.data);
    }

    fetchStub = installFetch((call) => {
      const base = call.url.slice(0, call.url.lastIndexOf("/API/"));
      if (call.url.endsWith("/API/GetNewSession")) {
        return Response.json({ session_id: "session-0" });
      }
      if (call.url.endsWith("/API/ListModels")) {
        return Response.json(responsesByBase.get(base));
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    const provider = new SwarmUIImageProvider();
    for (const [index, base] of bases.entries()) {
      const error = await captureProviderError(provider.listModelsBySubtype("", base, "loras"));
      expect(error.provider, invalidResponses[index]!.label).toBe("SwarmUI");
      expect(error.operation, invalidResponses[index]!.label).toBe("model listing");
      expect(error.detail, invalidResponses[index]!.label).toBe(
        "SwarmUI returned an invalid model listing response",
      );
    }
  });

  test("accepts an empty files array as an empty library", async () => {
    const base = uniqueBase();
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        return Response.json({ session_id: "session-0" });
      }
      if (call.url === `${base}/API/ListModels`) {
        return Response.json({ folders: [], files: [] });
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    await expect(
      new SwarmUIImageProvider().listModelsBySubtype("", base, "loras"),
    ).resolves.toEqual([]);
  });

  test("uses parsed codes for malformed and oversized logical error IDs", async () => {
    const malformedBase = uniqueBase();
    const oversizedBase = uniqueBase();
    const oversizedErrorId = "x".repeat(600);
    const errorsByBase = new Map<string, unknown>([
      [malformedBase, { error: "Invalid sub-type.", error_id: { unexpected: true } }],
      [oversizedBase, { error: "Invalid sub-type.", error_id: oversizedErrorId }],
    ]);

    fetchStub = installFetch((call) => {
      if (call.url.endsWith("/API/GetNewSession")) {
        return Response.json({ session_id: "session-0" });
      }
      if (call.url.endsWith("/API/ListModels")) {
        const base = call.url.slice(0, call.url.lastIndexOf("/API/"));
        return Response.json(errorsByBase.get(base));
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    const provider = new SwarmUIImageProvider();
    const malformed = await captureProviderError(
      provider.listModelsBySubtype("", malformedBase, "loras"),
    );
    expect(malformed).toMatchObject({
      code: "Invalid sub-type.",
      detail: "Invalid sub-type.",
    });

    const oversized = await captureProviderError(
      provider.listModelsBySubtype("", oversizedBase, "loras"),
    );
    expect(oversized.code).toBe(`${"x".repeat(497)}...`);
    expect(oversized.code).toHaveLength(500);
    expect(oversized.detail).toBe("Invalid sub-type.");
  });

  test("lets one caller abort its wait without aborting a shared session handshake", async () => {
    const base = uniqueBase();
    const handshakeStarted = deferred<void>();
    const handshake = deferred<Response>();

    fetchStub = installFetch((call) => {
      if (call.url !== `${base}/API/GetNewSession`) {
        throw new Error(`Unexpected fetch: ${call.url}`);
      }
      handshakeStarted.resolve();
      return handshake.promise;
    });

    const provider = new SwarmUIImageProvider();
    const internals = provider as unknown as SessionInternals;
    const controller = new AbortController();
    const first = internals.getSession(base, undefined, controller.signal);
    await handshakeStarted.promise;
    const second = internals.getSession(base);

    controller.abort();
    await expect(first).rejects.toBe(controller.signal.reason);
    const handshakeSignal = fetchStub.calls[0]?.signal;
    expect(handshakeSignal).not.toBe(controller.signal);
    expect(handshakeSignal?.aborted).toBe(false);

    handshake.resolve(Response.json({ session_id: "shared-session" }));
    await expect(second).resolves.toBe("shared-session");
    expect(fetchStub.calls.filter((call) => call.url.endsWith("/API/GetNewSession"))).toHaveLength(1);
  });

  test("sweeps expired session entries before reusing a session key", async () => {
    const base = uniqueBase();
    const originalNow = Date.now;
    let now = originalNow();
    let sessionRequests = 0;
    Date.now = () => now;

    try {
      fetchStub = installFetch((call) => {
        if (call.url !== `${base}/API/GetNewSession`) {
          throw new Error(`Unexpected fetch: ${call.url}`);
        }
        sessionRequests += 1;
        return Response.json({ session_id: `session-${sessionRequests}` });
      });

      const provider = new SwarmUIImageProvider();
      const internals = provider as unknown as SessionInternals;
      await expect(internals.getSession(base)).resolves.toBe("session-1");
      now += (25 * 60 * 1000) + 1;
      await expect(internals.getSession(base)).resolves.toBe("session-2");

      expect(sessionRequests).toBe(2);
      expect(internals.sessions.size).toBe(1);
    } finally {
      Date.now = originalNow;
    }
  });

  test("bounds session cache entries and retains a promoted session at capacity", async () => {
    const bases = Array.from({ length: 129 }, () => uniqueBase());
    let sessionRequests = 0;
    fetchStub = installFetch((call) => {
      if (!call.url.endsWith("/API/GetNewSession")) {
        throw new Error(`Unexpected fetch: ${call.url}`);
      }
      sessionRequests += 1;
      return Response.json({ session_id: `session-${sessionRequests}` });
    });

    const provider = new SwarmUIImageProvider();
    const internals = provider as unknown as SessionInternals;
    for (const base of bases.slice(0, 128)) {
      await internals.getSession(base);
    }
    await internals.getSession(bases[0]!);
    await internals.getSession(bases[128]!);

    expect(internals.sessions.size).toBe(128);
    expect([...internals.sessions.keys()].some((key) => key.startsWith(`${bases[0]!}\0`))).toBe(true);
    expect([...internals.sessions.keys()].some((key) => key.startsWith(`${bases[1]!}\0`))).toBe(false);
    expect(sessionRequests).toBe(129);

    await internals.getSession(bases[1]!);
    expect(sessionRequests).toBe(130);
    expect(internals.sessions.size).toBe(128);
  });

  test("bounds pending handshakes while coalescing an admitted key", async () => {
    const bases = Array.from({ length: 129 }, () => uniqueBase());
    const admittedBases = bases.slice(0, 128);
    const handshakes = admittedBases.map(() => deferred<Response>());
    let sessionRequests = 0;
    fetchStub = installFetch((call) => {
      if (!call.url.endsWith("/API/GetNewSession")) {
        throw new Error(`Unexpected fetch: ${call.url}`);
      }
      const base = call.url.slice(0, -"/API/GetNewSession".length);
      const index = admittedBases.indexOf(base);
      if (index < 0) {
        if (base !== bases[128]) throw new Error(`Unexpected session base: ${base}`);
        sessionRequests += 1;
        return Response.json({ session_id: "recovered-session" });
      }
      sessionRequests += 1;
      return handshakes[index]!.promise;
    });

    const provider = new SwarmUIImageProvider();
    const internals = provider as unknown as SessionInternals;
    const firstCalls = admittedBases.map((base) => internals.getSession(base));
    expect(sessionRequests).toBe(128);
    expect(internals.sessions.size).toBe(0);
    expect(internals.pendingSessions.size).toBe(128);

    const repeatedFirst = internals.getSession(admittedBases[0]!);
    expect(sessionRequests).toBe(128);
    await expect(internals.getSession(bases[128]!)).rejects.toMatchObject({
      code: "session_capacity_reached",
      retryable: true,
    });
    expect(sessionRequests).toBe(128);
    expect(internals.pendingSessions.size).toBe(128);

    for (const [index, handshake] of handshakes.entries()) {
      handshake.resolve(Response.json({ session_id: `session-${index}` }));
    }
    await Promise.all([...firstCalls, repeatedFirst]);

    expect(internals.pendingSessions.size).toBe(0);
    expect(internals.sessions.size).toBe(128);

    await expect(internals.getSession(bases[128]!)).resolves.toBe("recovered-session");
    expect(sessionRequests).toBe(129);
  });

  test("cleans a rejected pending handshake before allowing a fresh session request", async () => {
    const base = uniqueBase();
    const failedHandshake = deferred<Response>();
    let sessionRequests = 0;
    fetchStub = installFetch((call) => {
      if (call.url !== `${base}/API/GetNewSession`) {
        throw new Error(`Unexpected fetch: ${call.url}`);
      }
      sessionRequests += 1;
      return sessionRequests === 1
        ? failedHandshake.promise
        : Response.json({ session_id: "recovered-session" });
    });

    const provider = new SwarmUIImageProvider();
    const internals = provider as unknown as SessionInternals;
    const first = internals.getSession(base);
    const joined = internals.getSession(base);
    expect(sessionRequests).toBe(1);
    expect(internals.pendingSessions.size).toBe(1);

    failedHandshake.reject(new Error("fixture handshake failed"));
    await expect(first).rejects.toThrow("fixture handshake failed");
    await expect(joined).rejects.toThrow("fixture handshake failed");
    expect(internals.pendingSessions.size).toBe(0);

    await expect(internals.getSession(base)).resolves.toBe("recovered-session");
    expect(sessionRequests).toBe(2);
    expect(internals.pendingSessions.size).toBe(0);
  });

  test("retries one stale-session ListModels response with a fresh session", async () => {
    const base = uniqueBase();
    let sessionRequests = 0;
    const listBodies: Record<string, unknown>[] = [];
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        sessionRequests += 1;
        return Response.json({ session_id: `session-${sessionRequests - 1}` });
      }
      if (call.url === `${base}/API/ListModels`) {
        const body = modelListBody(call);
        listBodies.push(body);
        if (body.session_id === "session-0") {
          return Response.json({
            error: "Session rejected.",
            error_id: " invalid_session_id ",
          });
        }
        return Response.json({ files: [{ name: "nested/recovered.safetensors" }] });
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    const models = await new SwarmUIImageProvider().listModelsBySubtype("", base, "loras");

    expect(models).toEqual([{ id: "nested/recovered.safetensors", label: "recovered" }]);
    expect(sessionRequests).toBe(2);
    expect(listBodies).toEqual([
      { session_id: "session-0", path: "", depth: 10, subtype: "LoRA" },
      { session_id: "session-1", path: "", depth: 10, subtype: "LoRA" },
    ]);
  });

  test("propagates the second stale-session response without another retry", async () => {
    const base = uniqueBase();
    let sessionRequests = 0;
    let listRequests = 0;
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        sessionRequests += 1;
        return Response.json({ session_id: `session-${sessionRequests - 1}` });
      }
      if (call.url === `${base}/API/ListModels`) {
        listRequests += 1;
        if (modelListBody(call).session_id === "session-2") {
          return Response.json({ files: [{ name: "nested/new-session.safetensors" }] });
        }
        return Response.json({
          error: "Invalid session ID. You may need to refresh the page.",
          error_id: "invalid_session_id",
        });
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    const provider = new SwarmUIImageProvider();
    const error = await captureProviderError(
      provider.listModelsBySubtype("", base, "loras"),
    );

    expect(error).toMatchObject({
      provider: "SwarmUI",
      operation: "model listing",
      code: "invalid_session_id",
      detail: "Invalid session ID. You may need to refresh the page.",
    });
    expect(sessionRequests).toBe(2);
    expect(listRequests).toBe(2);

    await expect(provider.listModelsBySubtype("", base, "loras")).resolves.toEqual([
      { id: "nested/new-session.safetensors", label: "new-session" },
    ]);
    expect(sessionRequests).toBe(3);
    expect(listRequests).toBe(3);
  });

  test("coalesces concurrent stale-session refreshes and reuses the fresh session", async () => {
    const base = uniqueBase();
    const initialStaleRequests = deferred<void>();
    const freshSessionRequested = deferred<void>();
    const freshSession = deferred<Response>();
    const staleResponses = [deferred<Response>(), deferred<Response>()];
    const listBodies: Record<string, unknown>[] = [];
    let sessionRequests = 0;
    let staleRequestCount = 0;

    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        sessionRequests += 1;
        if (sessionRequests === 1) return Response.json({ session_id: "session-0" });
        if (sessionRequests === 2) {
          freshSessionRequested.resolve();
          return freshSession.promise;
        }
        throw new Error("Expected exactly one refreshed session request");
      }

      if (call.url === `${base}/API/ListModels`) {
        const body = modelListBody(call);
        listBodies.push(body);
        if (body.session_id === "session-0") {
          const staleResponse = staleResponses[staleRequestCount];
          if (!staleResponse) throw new Error("Unexpected stale ListModels request");
          staleRequestCount += 1;
          if (staleRequestCount === 2) initialStaleRequests.resolve();
          return staleResponse.promise;
        }
        if (body.session_id === "session-1") {
          return Response.json({ files: [{ name: `${String(body.subtype)}/fresh.safetensors` }] });
        }
        throw new Error(`Unexpected ListModels session: ${String(body.session_id)}`);
      }

      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    const provider = new SwarmUIImageProvider();
    const first = provider.listModelsBySubtype("", base, "loras");
    const second = provider.listModelsBySubtype("", base, "loras");
    await initialStaleRequests.promise;

    staleResponses[0].resolve(Response.json({
      error: "Invalid session ID. You may need to refresh the page.",
      error_id: "invalid_session_id",
    }));
    await freshSessionRequested.promise;

    staleResponses[1].resolve(Response.json({
      error: "Invalid session ID. You may need to refresh the page.",
      error_id: "invalid_session_id",
    }));
    await Promise.resolve();
    await Promise.resolve();
    freshSession.resolve(Response.json({ session_id: "session-1" }));

    const [firstModels, secondModels] = await Promise.all([first, second]);
    expect(firstModels).toEqual([{ id: "LoRA/fresh.safetensors", label: "fresh" }]);
    expect(secondModels).toEqual([{ id: "LoRA/fresh.safetensors", label: "fresh" }]);
    expect(sessionRequests).toBe(2);
    expect(listBodies.filter((body) => body.session_id === "session-1")).toHaveLength(2);

    const vaeModels = await provider.listModelsBySubtype("", base, "vae");
    expect(vaeModels).toEqual([{ id: "VAE/fresh.safetensors", label: "fresh" }]);
    expect(sessionRequests).toBe(2);
    expect(
      listBodies.filter((body) => body.session_id === "session-1" && body.subtype === "VAE"),
    ).toHaveLength(1);
  });

  test("isolates token-scoped model caches and sends only the matching dummy cookie", async () => {
    const base = uniqueBase();
    const sessionCookies: string[] = [];
    const listCookies: string[] = [];
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        if (!call.cookie) throw new Error("Expected a dummy token cookie");
        sessionCookies.push(call.cookie);
        return Response.json({
          session_id: call.cookie === "swarm_token=token-A" ? "session-A" : "session-B",
        });
      }
      if (call.url === `${base}/API/ListModels`) {
        if (!call.cookie) throw new Error("Expected a dummy token cookie");
        listCookies.push(call.cookie);
        const body = modelListBody(call);
        return Response.json({
          files: [{
            name: body.session_id === "session-A"
              ? "token-a/model.safetensors"
              : "token-b/model.safetensors",
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });

    const provider = new SwarmUIImageProvider();
    const tokenAModels = await provider.listModelsBySubtype("token-A", base, "loras");
    const tokenBModels = await provider.listModelsBySubtype("token-B", base, "loras");
    const tokenAHit = await provider.listModelsBySubtype("token-A", base, "loras");

    expect(tokenAModels).toEqual([{ id: "token-a/model.safetensors", label: "model" }]);
    expect(tokenBModels).toEqual([{ id: "token-b/model.safetensors", label: "model" }]);
    expect(tokenAHit).toEqual(tokenAModels);
    expect(sessionCookies).toEqual(["swarm_token=token-A", "swarm_token=token-B"]);
    expect(listCookies).toEqual(["swarm_token=token-A", "swarm_token=token-B"]);
    const internals = provider as unknown as SessionInternals;
    const sessionKeys = [...internals.sessions.keys()];
    expect(sessionKeys).toHaveLength(2);
    expect(sessionKeys.some((key) => key.includes("token-A") || key.includes("token-B"))).toBe(false);
  });

  test("sweeps expired cache entries using the current clock", async () => {
    const base = uniqueBase();
    const originalNow = Date.now;
    let now = originalNow();
    let sessionRequests = 0;
    let listRequests = 0;
    Date.now = () => now;

    try {
      fetchStub = installFetch((call) => {
        if (call.url === `${base}/API/GetNewSession`) {
          sessionRequests += 1;
          return Response.json({ session_id: "session-0" });
        }
        if (call.url === `${base}/API/ListModels`) {
          listRequests += 1;
          return Response.json({ files: [{ name: `model-${listRequests}.safetensors` }] });
        }
        throw new Error(`Unexpected fetch: ${call.url}`);
      });

      const provider = new SwarmUIImageProvider();
      await provider.listModelsBySubtype("", base, "loras");
      now += (5 * 60 * 1000) + 1;
      await provider.listModelsBySubtype("", base, "vae");
      await provider.listModelsBySubtype("", base, "loras");

      expect(sessionRequests).toBe(1);
      expect(listRequests).toBe(3);
    } finally {
      Date.now = originalNow;
    }
  });

  test("evicts the oldest cache entry at capacity and promotes hits before eviction", async () => {
    const originalNow = Date.now;
    let now = originalNow() + 24 * 60 * 60 * 1000;
    let listRequests = 0;
    Date.now = () => now;

    try {
      fetchStub = installFetch((call) => {
        if (call.url.endsWith("/API/GetNewSession")) {
          return Response.json({ session_id: "session-0" });
        }
        if (call.url.endsWith("/API/ListModels")) {
          listRequests += 1;
          const body = modelListBody(call);
          return Response.json({ files: [{ name: `${String(body.path)}.safetensors` }] });
        }
        throw new Error(`Unexpected fetch: ${call.url}`);
      });

      const provider = new SwarmUIImageProvider();
      // The cache cap is observable only at this internal boundary.
      const internals = provider as unknown as ModelListInternals;
      const evictionBase = uniqueBase();
      for (let index = 0; index < 129; index += 1) {
        await internals.fetchModelList("", evictionBase, {
          path: `eviction-${index}`,
          depth: 10,
          subtype: "LoRA",
        });
      }
      expect(listRequests).toBe(129);
      await internals.fetchModelList("", evictionBase, {
        path: "eviction-0",
        depth: 10,
        subtype: "LoRA",
      });
      expect(listRequests).toBe(130);

      now += (5 * 60 * 1000) + 1;
      const promotionBase = uniqueBase();
      const promotionStart = listRequests;
      for (let index = 0; index < 128; index += 1) {
        await internals.fetchModelList("", promotionBase, {
          path: `promotion-${index}`,
          depth: 10,
          subtype: "LoRA",
        });
      }
      expect(listRequests).toBe(promotionStart + 128);
      await internals.fetchModelList("", promotionBase, {
        path: "promotion-0",
        depth: 10,
        subtype: "LoRA",
      });
      expect(listRequests).toBe(promotionStart + 128);
      await internals.fetchModelList("", promotionBase, {
        path: "promotion-128",
        depth: 10,
        subtype: "LoRA",
      });
      expect(listRequests).toBe(promotionStart + 129);
      await internals.fetchModelList("", promotionBase, {
        path: "promotion-0",
        depth: 10,
        subtype: "LoRA",
      });
      expect(listRequests).toBe(promotionStart + 129);
      await internals.fetchModelList("", promotionBase, {
        path: "promotion-1",
        depth: 10,
        subtype: "LoRA",
      });
      expect(listRequests).toBe(promotionStart + 130);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("Image provider preview streaming capabilities", () => {
  test("advertises preview/status streaming only for WebSocket-capable providers", () => {
    expect(new ComfyUIImageProvider().capabilities.websocketPreviewStreaming).toEqual({
      previews: true,
      status: true,
    });
    expect(new SwarmUIImageProvider().capabilities.websocketPreviewStreaming).toEqual({
      previews: true,
      status: true,
    });
  });
});

describe("Image provider streaming lifecycle", () => {
  let fetchStub: InstalledFetch;

  afterEach(() => fetchStub?.restore());
  test("aborts a pending WebSocket handshake and removes every listener", async () => {
    const originalWebSocket = globalThis.WebSocket;
    TestWebSocket.instances = [];
    TestWebSocket.autoOpen = false;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
    try {
      const controller = new AbortController();
      const pending = openWebSocket("ws://stream-test.invalid/ws", {
        label: "stream-test",
        timeoutMs: 1_000,
        signal: controller.signal,
      });
      await flushMicrotasks();
      const ws = TestWebSocket.instances[0];
      expect(ws).toBeDefined();
      expect(ws?.listenerCount()).toBe(3);

      controller.abort("test abort");
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(ws?.readyState).toBe(3);
      expect(ws?.listenerCount()).toBe(0);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      TestWebSocket.autoOpen = true;
      TestWebSocket.instances = [];
    }
  });

  test("sends Swarm auth headers and interrupts exactly once when a consumer breaks", async () => {
    const base = uniqueBase();
    const originalWebSocket = globalThis.WebSocket;
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        return Response.json({ session_id: "session-stream" });
      }
      if (call.url === `${base}/API/InterruptAll`) {
        return Response.json({});
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });
    TestWebSocket.instances = [];
    TestWebSocket.autoOpen = true;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    try {
      const stream = new SwarmUIImageProvider().generateStream("secret-token", base, {
        prompt: "a fox",
        model: "sd_xl",
        parameters: {},
      });
      const first = stream.next();
      await flushMicrotasks();
      const ws = TestWebSocket.instances[0];
      expect(ws).toBeDefined();
      await flushMicrotasks();
      expect(ws?.headers).toEqual({
        "Content-Type": "application/json",
        Cookie: "swarm_token=secret-token",
      });
      expect(ws?.sent).toHaveLength(1);

      ws?.emitMessage(JSON.stringify({ gen_progress: { overall_percent: 0.25 } }));
      await expect(first).resolves.toEqual({
        done: false,
        value: { step: 25, totalSteps: 100 },
      });

      await stream.return({ imageDataUrl: "", model: "sd_xl", provider: "swarmui" });
      const interrupts = fetchStub.calls.filter((call) => call.url === `${base}/API/InterruptAll`);
      expect(interrupts).toHaveLength(1);
      expect(interrupts[0]?.body).toEqual({ session_id: "session-stream" });
      expect(ws?.readyState).toBe(3);
      expect(ws?.listenerCount()).toBe(0);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      TestWebSocket.instances = [];
    }
  });

  test("preserves Comfy encoded preview MIME and ignores unsupported binary frames", async () => {
    const base = uniqueBase();
    const prompt = deferred<Response>();
    const originalWebSocket = globalThis.WebSocket;
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/prompt`) {
        return prompt.promise;
      }
      if (call.url === `${base}/history/prompt-1`) {
        return Response.json({
          "prompt-1": {
            outputs: {
              "node-1": {
                images: [{ filename: "result.jpg", subfolder: "", type: "output" }],
              },
            },
          },
        });
      }
      if (call.url.includes("/view?")) {
        return new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });
    TestWebSocket.instances = [];
    TestWebSocket.autoOpen = true;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    try {
      const stream = new ComfyUIImageProvider().generateStream("", base, {
        prompt: "a fox",
        model: "sd_xl",
        parameters: { workflow: { "node-1": {} } },
      });
      const first = stream.next();
      await flushMicrotasks();
      const ws = TestWebSocket.instances[0];
      expect(ws).toBeDefined();
      prompt.resolve(Response.json({ prompt_id: "prompt-1" }));
      await flushMicrotasks();

      const previewBytes = new Uint8Array(10);
      new DataView(previewBytes.buffer).setUint32(0, 1);
      new DataView(previewBytes.buffer).setUint32(4, 1);
      previewBytes.set([1, 2], 8);
      ws?.emitMessage(previewBytes.buffer);
      await expect(first).resolves.toEqual({
        done: false,
        value: { preview: "data:image/jpeg;base64,AQI=" },
      });
      const unsupported = new Uint8Array(10);
      new DataView(unsupported.buffer).setUint32(0, 1);
      new DataView(unsupported.buffer).setUint32(4, 3);
      ws?.emitMessage(unsupported.buffer);
      ws?.emitMessage(JSON.stringify({
        type: "executing",
        data: { prompt_id: "prompt-1", node: null },
      }));
      const result = await stream.next();
      expect(result.done).toBe(true);
      if (!result.done) throw new Error("Expected Comfy stream to complete");
      expect(result.value.imageDataUrl).toBe("data:image/jpeg;base64,CQgH");
      expect(ws?.listenerCount()).toBe(0);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      TestWebSocket.instances = [];
    }
  });
  test("does not interrupt Comfy after terminal completion during result fetch", async () => {
    const base = uniqueBase();
    const prompt = deferred<Response>();
    const history = deferred<Response>();
    const image = deferred<Response>();
    const controller = new AbortController();
    const originalWebSocket = globalThis.WebSocket;
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/prompt`) return prompt.promise;
      if (call.url === `${base}/history/prompt-terminal`) return history.promise;
      if (call.url.includes("/view?")) return image.promise;
      if (call.url.endsWith("/interrupt")) return Response.json({});
      throw new Error(`Unexpected fetch: ${call.url}`);
    });
    TestWebSocket.instances = [];
    TestWebSocket.autoOpen = true;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    try {
      const stream = new ComfyUIImageProvider().generateStream("", base, {
        prompt: "a fox",
        model: "sd_xl",
        signal: controller.signal,
        parameters: { workflow: { "node-1": {} } },
      });
      const pending = stream.next();
      await flushMicrotasks();
      const ws = TestWebSocket.instances[0];
      prompt.resolve(Response.json({ prompt_id: "prompt-terminal" }));
      await flushMicrotasks();
      ws?.emitMessage(JSON.stringify({
        type: "executing",
        data: { prompt_id: "prompt-terminal", node: null },
      }));
      await flushMicrotasks();
      expect(fetchStub.calls.some((call) => call.url === `${base}/history/prompt-terminal`)).toBe(true);

      controller.abort("late abort");
      expect(fetchStub.calls.filter((call) => call.url.endsWith("/interrupt"))).toHaveLength(0);
      history.resolve(Response.json({
        "prompt-terminal": {
          outputs: {
            "node-1": {
              images: [{ filename: "result.png", subfolder: "", type: "output" }],
            },
          },
        },
      }));
      image.resolve(new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }));
      const result = await pending;
      expect(result.done).toBe(true);
      if (!result.done) throw new Error("Expected Comfy stream to complete");
      expect(result.value.imageDataUrl).toBe("data:image/png;base64,AQID");
      expect(ws?.listenerCount()).toBe(0);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      TestWebSocket.instances = [];
    }
  });

  test("does not interrupt Swarm after terminal completion during image fetch", async () => {
    const base = uniqueBase();
    const session = deferred<Response>();
    const image = deferred<Response>();
    const controller = new AbortController();
    const originalWebSocket = globalThis.WebSocket;
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) return session.promise;
      if (call.url === `${base}/out.png`) return image.promise;
      if (call.url === `${base}/API/InterruptAll`) return Response.json({});
      throw new Error(`Unexpected fetch: ${call.url}`);
    });
    TestWebSocket.instances = [];
    TestWebSocket.autoOpen = true;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    try {
      const stream = new SwarmUIImageProvider().generateStream("secret-token", base, {
        prompt: "a fox",
        model: "sd_xl",
        signal: controller.signal,
        parameters: {},
      });
      const pending = stream.next();
      await flushMicrotasks();
      session.resolve(Response.json({ session_id: "session-terminal" }));
      await flushMicrotasks();
      const ws = TestWebSocket.instances[0];
      ws?.emitMessage(JSON.stringify({ image: "out.png" }));
      ws?.emitMessage(JSON.stringify({ discard_indices: [] }));
      await flushMicrotasks();
      expect(fetchStub.calls.some((call) => call.url === `${base}/out.png`)).toBe(true);

      controller.abort("late abort");
      expect(fetchStub.calls.filter((call) => call.url === `${base}/API/InterruptAll`)).toHaveLength(0);
      image.resolve(new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }));
      const result = await pending;
      expect(result.done).toBe(true);
      if (!result.done) throw new Error("Expected Swarm stream to complete");
      expect(result.value.imageDataUrl).toBe("data:image/png;base64,BAUG");
      expect(ws?.listenerCount()).toBe(0);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      TestWebSocket.instances = [];
    }
  });

  test("drains a queued Comfy terminal event after the socket closes", async () => {
    const base = uniqueBase();
    const prompt = deferred<Response>();
    const controller = new AbortController();
    const abortListeners = trackAbortListeners(controller.signal);
    const originalWebSocket = globalThis.WebSocket;
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/prompt`) return prompt.promise;
      if (call.url === `${base}/history/prompt-paused`) {
        return Response.json({
          "prompt-paused": {
            outputs: {
              "node-1": {
                images: [{ filename: "result.png", subfolder: "", type: "output" }],
              },
            },
          },
        });
      }
      if (call.url.includes("/view?")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      if (call.url.endsWith("/interrupt")) return Response.json({});
      throw new Error(`Unexpected fetch: ${call.url}`);
    });
    TestWebSocket.instances = [];
    TestWebSocket.autoOpen = true;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    try {
      const stream = new ComfyUIImageProvider().generateStream("", base, {
        prompt: "a fox",
        model: "sd_xl",
        signal: controller.signal,
        parameters: { workflow: { "node-1": {} } },
      });
      const first = stream.next();
      await flushMicrotasks();
      const ws = TestWebSocket.instances[0];
      prompt.resolve(Response.json({ prompt_id: "prompt-paused" }));
      await flushMicrotasks();
      ws?.emitMessage(JSON.stringify({
        type: "progress",
        data: { prompt_id: "prompt-paused", value: 1, max: 2 },
      }));
      await expect(first).resolves.toEqual({
        done: false,
        value: { step: 1, totalSteps: 2 },
      });

      ws?.emitMessage(JSON.stringify({
        type: "executing",
        data: { prompt_id: "prompt-paused", node: null },
      }));
      ws?.close();
      const result = await stream.next();
      expect(result.done).toBe(true);
      if (!result.done) throw new Error("Expected Comfy stream to complete");
      expect(result.value.imageDataUrl).toBe("data:image/png;base64,AQID");
      expect(fetchStub.calls.filter((call) => call.url.endsWith("/interrupt"))).toHaveLength(0);
      expect(ws?.listenerCount()).toBe(0);
      expect(abortListeners.active.size).toBe(0);
    } finally {
      abortListeners.restore();
      globalThis.WebSocket = originalWebSocket;
      TestWebSocket.instances = [];
    }
  });

  test("drains queued Swarm completion after the socket closes", async () => {
    const base = uniqueBase();
    const controller = new AbortController();
    const abortListeners = trackAbortListeners(controller.signal);
    const originalWebSocket = globalThis.WebSocket;
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        return Response.json({ session_id: "session-paused" });
      }
      if (call.url === `${base}/out.png`) {
        return new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      if (call.url === `${base}/API/InterruptAll`) return Response.json({});
      throw new Error(`Unexpected fetch: ${call.url}`);
    });
    TestWebSocket.instances = [];
    TestWebSocket.autoOpen = true;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    try {
      const stream = new SwarmUIImageProvider().generateStream("secret-token", base, {
        prompt: "a fox",
        model: "sd_xl",
        signal: controller.signal,
        parameters: {},
      });
      const first = stream.next();
      await flushMicrotasks();
      const ws = TestWebSocket.instances[0];
      ws?.emitMessage(JSON.stringify({ gen_progress: { overall_percent: 0.25 } }));
      await expect(first).resolves.toEqual({
        done: false,
        value: { step: 25, totalSteps: 100 },
      });

      ws?.emitMessage(JSON.stringify({ image: "out.png" }));
      ws?.emitMessage(JSON.stringify({ discard_indices: [] }));
      ws?.close();
      const result = await stream.next();
      expect(result.done).toBe(true);
      if (!result.done) throw new Error("Expected Swarm stream to complete");
      expect(result.value.imageDataUrl).toBe("data:image/png;base64,BAUG");
      expect(fetchStub.calls.filter((call) => call.url === `${base}/API/InterruptAll`)).toHaveLength(0);
      expect(ws?.listenerCount()).toBe(0);
      expect(abortListeners.active.size).toBe(0);
    } finally {
      abortListeners.restore();
      globalThis.WebSocket = originalWebSocket;
      TestWebSocket.instances = [];
    }
  });

  test("builds the Swarm request before opening its WebSocket", async () => {
    const base = uniqueBase();
    const originalWebSocket = globalThis.WebSocket;
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        return Response.json({ session_id: "session-preflight" });
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });
    TestWebSocket.instances = [];
    TestWebSocket.autoOpen = false;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    try {
      const stream = new SwarmUIImageProvider().generateStream("secret-token", base, {
        prompt: "a fox",
        model: "sd_xl",
        parameters: { rawRequestOverride: "{not valid json" },
      });
      await expect(stream.next()).rejects.toThrow(/not valid JSON/);
      expect(TestWebSocket.instances).toHaveLength(0);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      TestWebSocket.autoOpen = true;
      TestWebSocket.instances = [];
    }
  });

  test("does not globally interrupt Comfy on terminal execution errors", async () => {
    const base = uniqueBase();
    const prompt = deferred<Response>();
    const originalWebSocket = globalThis.WebSocket;
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/prompt`) return prompt.promise;
      throw new Error(`Unexpected fetch: ${call.url}`);
    });
    TestWebSocket.instances = [];
    TestWebSocket.autoOpen = true;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    try {
      const stream = new ComfyUIImageProvider().generateStream("", base, {
        prompt: "a fox",
        model: "sd_xl",
        parameters: { workflow: { "node-1": {} } },
      });
      const pending = stream.next();
      await flushMicrotasks();
      const ws = TestWebSocket.instances[0];
      prompt.resolve(Response.json({ prompt_id: "prompt-error" }));
      await flushMicrotasks();
      ws?.emitMessage(JSON.stringify({
        type: "execution_error",
        data: { prompt_id: "prompt-error", exception_message: "node failed" },
      }));
      await expect(pending).rejects.toThrow(/execution error: node failed/);
      expect(fetchStub.calls.filter((call) => call.url.endsWith("/interrupt"))).toHaveLength(0);
      expect(ws?.readyState).toBe(3);
      expect(ws?.listenerCount()).toBe(0);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      TestWebSocket.instances = [];
    }
  });

  test("does not interrupt a shared Swarm session on terminal generation errors", async () => {
    const base = uniqueBase();
    const session = deferred<Response>();
    const originalWebSocket = globalThis.WebSocket;
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/API/GetNewSession`) {
        return session.promise;
      }
      if (call.url === `${base}/API/InterruptAll`) {
        return Response.json({});
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });
    TestWebSocket.instances = [];
    TestWebSocket.autoOpen = true;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    try {
      const stream = new SwarmUIImageProvider().generateStream("secret-token", base, {
        prompt: "a fox",
        model: "sd_xl",
        parameters: {},
      });
      const pending = stream.next();
      await flushMicrotasks();
      session.resolve(Response.json({ session_id: "session-error" }));
      await flushMicrotasks();
      const ws = TestWebSocket.instances[0];
      await flushMicrotasks();
      ws?.emitMessage(JSON.stringify({ error: "generation failed" }));
      await expect(pending).rejects.toThrow(/generation failed/);
      expect(fetchStub.calls.filter((call) => call.url === `${base}/API/InterruptAll`)).toHaveLength(0);
      expect(ws?.readyState).toBe(3);
      expect(ws?.listenerCount()).toBe(0);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      TestWebSocket.instances = [];
    }
  });


  test("closes the Comfy socket when prompt setup fails", async () => {
    const base = uniqueBase();
    const originalWebSocket = globalThis.WebSocket;
    fetchStub = installFetch((call) => {
      if (call.url === `${base}/prompt`) {
        return Promise.resolve(new Response("bad workflow", { status: 400 }));
      }
      throw new Error(`Unexpected fetch: ${call.url}`);
    });
    TestWebSocket.instances = [];
    TestWebSocket.autoOpen = true;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;

    try {
      const stream = new ComfyUIImageProvider().generateStream("", base, {
        prompt: "a fox",
        model: "sd_xl",
        parameters: { workflow: { "node-1": {} } },
      });
      await expect(stream.next()).rejects.toThrow(/rejected workflow/);
      const ws = TestWebSocket.instances[0];
      expect(ws?.readyState).toBe(3);
      expect(ws?.listenerCount()).toBe(0);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      TestWebSocket.instances = [];
    }
  });
});
