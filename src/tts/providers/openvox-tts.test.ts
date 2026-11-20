import { afterEach, describe, expect, test } from "bun:test";
import { OpenVoxTtsProvider } from "./openvox-tts";

const originalFetch = globalThis.fetch;

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function asFetchStub(fn: FetchStub): typeof fetch {
  const stub = Object.assign(fn.bind(globalThis), { preconnect() {} });
  return stub as typeof fetch;
}

function isModelLoadRequest(input: RequestInfo | URL): boolean {
  return String(input).endsWith("/load");
}

function successfulModelLoad(): Response {
  return new Response(JSON.stringify({ status: "loaded" }), {
    headers: { "content-type": "application/json" },
  });
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

function speechRequest(text: string, signal?: AbortSignal) {
  return {
    text,
    model: "kokoro",
    voice: "af_bella",
    parameters: {},
    signal,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenVoxTtsProvider", () => {
  test("uses the Lumiverse provider naming convention and local defaults", () => {
    const provider = new OpenVoxTtsProvider();

    expect(provider.name).toBe("openvox_tts");
    expect(provider.displayName).toBe("OpenVox TTS");
    expect(provider.capabilities.apiKeyRequired).toBe(false);
    expect(provider.capabilities.modelListStyle).toBe("dynamic");
    expect(provider.capabilities.voiceListStyle).toBe("dynamic");
    expect(provider.capabilities.defaultUrl).toBe("http://127.0.0.1:8000/v1");
    expect(provider.capabilities.parameters.language).toBeUndefined();
  });

  test("lists every OpenVox model without the generic TTS name filter", async () => {
    const calls: string[] = [];
    globalThis.fetch = asFetchStub(async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        data: [
          { id: "kokoro", name: "Kokoro-82M" },
          { id: "chatterbox-turbo-small", name: "Chatterbox Turbo Small" },
          { id: "qwen3-tts", name: "Qwen3 TTS" },
        ],
      }));
    });

    const models = await new OpenVoxTtsProvider().listModels("", "");

    expect(calls).toEqual(["http://127.0.0.1:8000/v1/models"]);
    expect(models).toEqual([
      { id: "chatterbox-turbo-small", label: "Chatterbox Turbo Small" },
      { id: "kokoro", label: "Kokoro-82M" },
      { id: "qwen3-tts", label: "Qwen3 TTS" },
    ]);
  });

  test("accepts the OpenVox models collection response shape", async () => {
    globalThis.fetch = asFetchStub(async () => new Response(JSON.stringify({
      models: ["omnivoice", { model_id: "pocket-tts", display_name: "Pocket TTS" }],
    })));

    const models = await new OpenVoxTtsProvider().listModels("", "http://localhost:9000/v1/");

    expect(models).toEqual([
      { id: "omnivoice", label: "omnivoice" },
      { id: "pocket-tts", label: "Pocket TTS" },
    ]);
  });

  test("lists and normalizes English voices for the selected model", async () => {
    const calls: string[] = [];
    globalThis.fetch = asFetchStub(async (input) => {
      calls.push(String(input));
      if (isModelLoadRequest(input)) return successfulModelLoad();
      return new Response(JSON.stringify({
        voices: [
          { id: "af_bella", name: "Bella", language: "en", gender: "female" },
          { voice_id: "am_adam", display_name: "Adam", language_code: "en", gender: "male" },
        ],
      }));
    });

    const voices = await new OpenVoxTtsProvider().listVoices(
      "",
      "http://127.0.0.1:8000/v1/audio/speech",
      { model: "chatterbox/turbo" },
    );

    expect(calls).toEqual([
      "http://127.0.0.1:8000/v1/models/chatterbox%2Fturbo/load",
      "http://127.0.0.1:8000/v1/models/chatterbox%2Fturbo/voices?language=en",
    ]);
    expect(voices).toEqual([
      { id: "am_adam", name: "Adam", language: "en", gender: "male" },
      { id: "af_bella", name: "Bella", language: "en", gender: "female" },
    ]);
  });

  test("does not request voices until a model is selected", async () => {
    let calls = 0;
    globalThis.fetch = asFetchStub(async () => {
      calls += 1;
      return new Response("{}");
    });

    const voices = await new OpenVoxTtsProvider().listVoices("", "", {});

    expect(voices).toEqual([]);
    expect(calls).toBe(0);
  });

  test("limits buffered speech requests to English", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let body: Record<string, unknown> = {};
    globalThis.fetch = asFetchStub(async (input, init) => {
      calls.push({ url: String(input), method: init?.method || "GET" });
      if (isModelLoadRequest(input)) return successfulModelLoad();
      body = JSON.parse(String(init?.body));
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/wav" },
      });
    });

    const result = await new OpenVoxTtsProvider().synthesize("", "", {
      text: "Hello",
      model: "kokoro",
      voice: "af_bella",
      parameters: { language: "fr", speed: 1.1 },
    });

    expect(calls).toEqual([
      { url: "http://127.0.0.1:8000/v1/models/kokoro/load", method: "POST" },
      { url: "http://127.0.0.1:8000/v1/audio/speech", method: "POST" },
    ]);
    expect(body).toEqual({
      model: "kokoro",
      input: "Hello",
      voice: "af_bella",
      response_format: "wav",
      speed: 1.1,
      language: "en",
    });
    expect(result.contentType).toBe("audio/wav");
  });

  test("runs synthesis requests for the same OpenVox endpoint one at a time in FIFO order", async () => {
    const started: string[] = [];
    const operations: string[] = [];
    const responseGates = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    const startSignals = [deferred<void>(), deferred<void>(), deferred<void>()];
    let active = 0;
    let maxActive = 0;

    globalThis.fetch = asFetchStub(async (input, init) => {
      if (isModelLoadRequest(input)) {
        operations.push("load");
        return successfulModelLoad();
      }
      const text = String(JSON.parse(String(init?.body)).input);
      operations.push(`synthesize:${text}`);
      const index = started.length;
      started.push(text);
      active += 1;
      maxActive = Math.max(maxActive, active);
      startSignals[index]!.resolve();
      const response = await responseGates[index]!.promise;
      active -= 1;
      return response;
    });

    const inputs = [
      { text: "first", url: "http://localhost:8000/v1/" },
      { text: "second", url: "http://localhost:8000/v1/audio/speech" },
      { text: "third", url: "http://localhost:8000/v1" },
    ];
    const results = inputs.map(({ text, url }) =>
      new OpenVoxTtsProvider().synthesize("", url, speechRequest(text))
    );

    await startSignals[0]!.promise;
    expect(started).toEqual(["first"]);

    responseGates[0]!.resolve(new Response(new Uint8Array([1]), {
      headers: { "content-type": "audio/wav" },
    }));
    await startSignals[1]!.promise;
    expect(started).toEqual(["first", "second"]);

    responseGates[1]!.resolve(new Response(new Uint8Array([2]), {
      headers: { "content-type": "audio/wav" },
    }));
    await startSignals[2]!.promise;
    expect(started).toEqual(["first", "second", "third"]);

    responseGates[2]!.resolve(new Response(new Uint8Array([3]), {
      headers: { "content-type": "audio/wav" },
    }));
    await Promise.all(results);
    expect(maxActive).toBe(1);
    expect(operations).toEqual([
      "load", "synthesize:first",
      "load", "synthesize:second",
      "load", "synthesize:third",
    ]);
  });

  test("releases the next queued request when synthesis fails", async () => {
    const calls: string[] = [];
    globalThis.fetch = asFetchStub(async (input, init) => {
      if (isModelLoadRequest(input)) return successfulModelLoad();
      const text = String(JSON.parse(String(init?.body)).input);
      calls.push(text);
      if (text === "first") {
        return new Response(JSON.stringify({ detail: "Busy" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array([2]), {
        headers: { "content-type": "audio/wav" },
      });
    });

    const provider = new OpenVoxTtsProvider();
    const first = provider.synthesize("", "", speechRequest("first"));
    const second = provider.synthesize("", "", speechRequest("second"));

    await expect(first).rejects.toMatchObject({ status: 429, detail: "Busy" });
    await expect(second).resolves.toMatchObject({ contentType: "audio/wav" });
    expect(calls).toEqual(["first", "second"]);
  });

  test("uses independent queues for different OpenVox endpoints", async () => {
    const bothStarted = deferred<void>();
    const responseGate = deferred<Response>();
    let active = 0;
    let maxActive = 0;

    globalThis.fetch = asFetchStub(async (input) => {
      if (isModelLoadRequest(input)) return successfulModelLoad();
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) bothStarted.resolve();
      const response = await responseGate.promise;
      active -= 1;
      return response.clone();
    });

    const provider = new OpenVoxTtsProvider();
    const first = provider.synthesize("", "http://openvox-a:8000/v1", speechRequest("first"));
    const second = provider.synthesize("", "http://openvox-b:8000/v1", speechRequest("second"));

    await bothStarted.promise;
    expect(maxActive).toBe(2);
    responseGate.resolve(new Response(new Uint8Array([1]), {
      headers: { "content-type": "audio/wav" },
    }));
    await Promise.all([first, second]);
  });

  test("removes an aborted waiter without blocking later queued requests", async () => {
    const firstResponse = deferred<Response>();
    const thirdResponse = deferred<Response>();
    const thirdStarted = deferred<void>();
    const started: string[] = [];

    globalThis.fetch = asFetchStub(async (input, init) => {
      if (isModelLoadRequest(input)) return successfulModelLoad();
      const text = String(JSON.parse(String(init?.body)).input);
      started.push(text);
      if (text === "first") return firstResponse.promise;
      thirdStarted.resolve();
      return thirdResponse.promise;
    });

    const provider = new OpenVoxTtsProvider();
    const controller = new AbortController();
    const first = provider.synthesize("", "", speechRequest("first"));
    const second = provider.synthesize("", "", speechRequest("second", controller.signal));
    const third = provider.synthesize("", "", speechRequest("third"));
    const secondResult = second.catch((error) => error);

    controller.abort();
    expect((await secondResult).name).toBe("AbortError");
    expect(started).toEqual(["first"]);

    firstResponse.resolve(new Response(new Uint8Array([1]), {
      headers: { "content-type": "audio/wav" },
    }));
    await thirdStarted.promise;
    expect(started).toEqual(["first", "third"]);

    thirdResponse.resolve(new Response(new Uint8Array([3]), {
      headers: { "content-type": "audio/wav" },
    }));
    await Promise.all([first, third]);
  });

  test("does not synthesize when model loading fails and releases the next queued request", async () => {
    let loadAttempts = 0;
    let synthesisCalls = 0;
    globalThis.fetch = asFetchStub(async (input) => {
      if (isModelLoadRequest(input)) {
        loadAttempts += 1;
        if (loadAttempts === 1) {
          return new Response(JSON.stringify({ detail: "Busy" }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return successfulModelLoad();
      }

      synthesisCalls += 1;
      return new Response(new Uint8Array([1]), {
        headers: { "content-type": "audio/wav" },
      });
    });

    const provider = new OpenVoxTtsProvider();
    const first = provider.synthesize("", "", speechRequest("first"));
    const second = provider.synthesize("", "", speechRequest("second"));

    await expect(first).rejects.toMatchObject({
      operation: "model loading",
      status: 429,
      detail: "Busy",
    });
    await expect(second).resolves.toMatchObject({ contentType: "audio/wav" });
    expect(loadAttempts).toBe(2);
    expect(synthesisCalls).toBe(1);
  });
});
