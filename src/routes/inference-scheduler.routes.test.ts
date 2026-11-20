import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import { InvalidSettingError, MAX_SAVED_THEMES_VALUE_BYTES } from "../services/settings-validation";

const settingsStore = new Map<string, unknown>();

mock.module("../services/settings.service", () => ({
  InvalidSettingError,
  MAX_SAVED_THEMES_VALUE_BYTES,
  getSetting: (userId: string, key: string) => (
    settingsStore.has(`${userId}:${key}`) ? { key, value: settingsStore.get(`${userId}:${key}`) } : null
  ),
  putSetting: (userId: string, key: string, value: unknown) => {
    settingsStore.set(`${userId}:${key}`, value);
    return { key, value };
  },
}));

mock.module("../services/inference-scheduler/discovery", () => ({
  discoverLocalInferenceEndpoints: async () => [
    {
      origin: "http://127.0.0.1:5001",
      label: "Chat — Local llama.cpp",
      sources: ["chat"],
      scheduled: true,
      excluded: false,
    },
  ],
}));

const { inferenceSchedulerRoutes } = await import("./inference-scheduler.routes");
const configModule = await import("../services/inference-scheduler/config");

function app(): Hono {
  const instance = new Hono();
  instance.use("*", async (c, next) => {
    c.set("userId", "route-user");
    return next();
  });
  instance.route("/", inferenceSchedulerRoutes);
  return instance;
}

beforeEach(() => {
  settingsStore.clear();
  configModule.resetInferenceSchedulerConfigForTests();
});

describe("inference scheduler routes", () => {
  test("returns config, status, and detected endpoints", async () => {
    const response = await app().request("/");
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.config.enabled).toBe(false);
    expect(body.status.enabled).toBe(false);
    expect(body.status.host).toBe(true);
    expect(body.endpoints).toHaveLength(1);
  });

  test("persists a partial config patch and clamps invalid numbers", async () => {
    const response = await app().request("/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, concurrency: 99, unifiedLocalPool: false }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.config.enabled).toBe(true);
    expect(body.config.concurrency).toBe(8);
    expect(body.config.unifiedLocalPool).toBe(false);

    const stored = settingsStore.get("route-user:inferenceSchedulerConfig") as any;
    expect(stored.enabled).toBe(true);
    expect(stored.concurrency).toBe(8);
  });

  test("rejects array config payloads with a 400", async () => {
    const response = await app().request("/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ enabled: true }]),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Inference scheduler config must be an object" });
  });

  test("rejects invalid JSON with a 400", async () => {
    const response = await app().request("/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  test("serves status and endpoints separately", async () => {
    const statusResponse = await app().request("/status");
    expect(statusResponse.status).toBe(200);
    expect((await statusResponse.json() as any).status.resources).toEqual([]);

    const endpointsResponse = await app().request("/endpoints");
    expect(endpointsResponse.status).toBe(200);
    expect((await endpointsResponse.json() as any).endpoints).toHaveLength(1);
  });
});
