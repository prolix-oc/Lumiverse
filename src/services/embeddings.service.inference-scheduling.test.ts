import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";
import { embeddingCache } from "./embedding-cache";
import {
  EMBEDDING_SETTINGS_KEY,
  embedTexts,
  embeddingProfileSecretKey,
} from "./embeddings.service";
import { DEFAULT_INFERENCE_SCHEDULER_CONFIG } from "./inference-scheduler/config";
import { __test__, withInferenceLease } from "./inference-scheduler/scheduler";

const USER = "scheduler-embedding-user";
const PROFILE_ID = "55555555-5555-4555-8555-555555555555";

const settings = new Map<string, unknown>();
const secrets = new Map<string, string>();
const spies: Array<{ mockRestore(): void }> = [];

function sk(userId: string, key: string): string {
  return `${userId}::${key}`;
}

function configureEmbedding(apiUrl: string): void {
  settings.set(sk(USER, EMBEDDING_SETTINGS_KEY), {
    enabled: true,
    provider: "openai-compatible",
    api_url: apiUrl,
    model: "text-embedding-3-small",
    dimensions: 2,
    send_dimensions: false,
    request_timeout: 30,
    batch_size: 16,
    connectionProfiles: [
      {
        id: PROFILE_ID,
        provider: "openai-compatible",
        model: "text-embedding-3-small",
        api_url: apiUrl,
        dimensions: 2,
        enabled: true,
      },
    ],
    primaryProfileId: PROFILE_ID,
    fallbackProfileIds: [],
  });
  secrets.set(sk(USER, embeddingProfileSecretKey(PROFILE_ID)), "test-key");
}

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function asFetchStub(fn: FetchStub): typeof fetch {
  const stub = Object.assign(fn.bind(globalThis), { preconnect() {} });
  return stub as typeof fetch;
}

function embeddingResponse(): Response {
  return Response.json({ data: [{ embedding: [0.5, 0.25] }] });
}

function enableScheduler(): void {
  __test__.setHost(true);
  __test__.setConfig({
    ...DEFAULT_INFERENCE_SCHEDULER_CONFIG,
    enabled: true,
    unifiedLocalPool: true,
    concurrency: 1,
    preemptBackground: false,
  });
}

beforeEach(() => {
  settings.clear();
  secrets.clear();
  embeddingCache.clear();
  enableScheduler();
  spies.push(
    spyOn(settingsSvc, "getSetting").mockImplementation((userId: string, key: string) => {
      const value = settings.get(sk(userId, key));
      return value === undefined ? null : { key, value, updated_at: 0 };
    }),
    spyOn(settingsSvc, "putSetting").mockImplementation((userId: string, key: string, value: unknown) => {
      settings.set(sk(userId, key), value);
      return { key, value, updated_at: 0 };
    }),
    spyOn(secretsSvc, "getSecret").mockImplementation(async (userId: string, key: string) => {
      return secrets.get(sk(userId, key)) ?? null;
    }),
    spyOn(secretsSvc, "getSecretForStatus").mockImplementation(async (userId: string, key: string) => {
      return secrets.get(sk(userId, key)) ?? null;
    }),
    spyOn(settingsSvc, "getSettingAsync").mockImplementation(async (...args) => settingsSvc.getSetting(...args)),
  );
});

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
  embeddingCache.clear();
  __test__.reset();
});

describe("embedding requests respect the inference scheduler", () => {
  test.skipIf(!process.env.INFERENCE_SCHEDULER_SIMULATION_URL)("serializes and preempts nested embedding HTTP requests", async () => {
    const baseUrl = process.env.INFERENCE_SCHEDULER_SIMULATION_URL!;
    configureEmbedding(`${baseUrl}/v1/embeddings`);
    expect((await fetch(`${baseUrl}/__reset`, { method: "POST" })).ok).toBe(true);
    await Promise.all([embedTexts(USER, ["first"]), embedTexts(USER, ["second"])]);
    const metrics = async (): Promise<{ active: number; peak: number; started: number; cancelled: number }> =>
      (await fetch(`${baseUrl}/__metrics`)).json();
    expect((await metrics()).peak).toBe(1);

    __test__.setConfig({ ...DEFAULT_INFERENCE_SCHEDULER_CONFIG, enabled: true });
    const background = withInferenceLease(
      { userId: USER, endpoint: baseUrl, requestClass: "background" },
      async () => embedTexts(USER, ["slow"], { signal: new AbortController().signal }),
    );
    // Attach rejection handling before preemption so cancellation is never unhandled.
    const result = background.then(() => null, (err: unknown) => err);
    const deadline = Date.now() + 1000;
    while ((await metrics()).started < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect((await metrics()).started).toBe(3);
    const interactive = withInferenceLease(
      { userId: USER, endpoint: baseUrl, requestClass: "interactive" },
      async () => embedTexts(USER, ["recovery"]),
    );
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(await interactive).toEqual([[0.5, 0.25]]);
    // The fixture holds slow requests for 2s. Cancellation and the next request
    // must complete before that response, even if the proxy keeps forwarding it.
    expect(Date.now()).toBeLessThan(deadline);
  });

  test("serializes concurrent requests to one local endpoint", async () => {
    configureEmbedding("http://127.0.0.1:5999/v1/embeddings");
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];

    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async (_input, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      started.push(String(JSON.parse(String(init?.body)).input));
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return embeddingResponse();
    })));

    await Promise.all([
      embedTexts(USER, ["first"]),
      embedTexts(USER, ["second"]),
    ]);

    expect(maxInFlight).toBe(1);
    expect(started).toEqual(["first", "second"]);
  });

  test("leaves remote embedding endpoints unscheduled", async () => {
    configureEmbedding("https://primary.test/v1/embeddings");
    let inFlight = 0;
    let maxInFlight = 0;

    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return embeddingResponse();
    })));

    await Promise.all([
      embedTexts(USER, ["first"]),
      embedTexts(USER, ["second"]),
    ]);

    expect(maxInFlight).toBe(2);
  });
});
