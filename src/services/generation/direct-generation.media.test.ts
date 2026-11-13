import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import * as connections from "../connections.service";
import * as presets from "../presets.service";
import * as secrets from "../secrets.service";
import * as pool from "../generation-pool.service";
import { rawGenerate } from "./direct-generation";
import { stopAllGenerations, stopGenerationSweep } from "../generate.service";
import { stopVertexTokenSweep } from "../../llm/providers/google-vertex";

const userId = "media-resolution-inheritance";
let connectionId: string;
let secretSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let body: any;

beforeAll(async () => {
  closeDatabase(); initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../../db/baseline.sql", import.meta.url)).text());
  secretSpy = spyOn(secrets, "getSecret").mockResolvedValue("test-key");
  const preset = await presets.createPreset(userId, { name: "Media detail", provider: "google",
    parameters: { media_resolution: "high", temperature: 0.123 } });
  connectionId = (await connections.createConnection(userId, { name: "Gemini", provider: "google", model: "gemini-3.8-flash", preset_id: preset.id })).id;
});

afterEach(() => fetchSpy?.mockRestore());
afterAll(() => {
  stopAllGenerations(); stopGenerationSweep(); stopVertexTokenSweep();
  pool.stopPoolSweep(); pool.clearAllPoolEntries(); secretSpy.mockRestore(); closeDatabase();
});

test("raw calls inherit only media detail from the bound connection preset and honor explicit overrides", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ candidates: [{ content: { parts: [{ text: "A small reply." }] }, finishReason: "STOP" }] });
  }) as typeof fetch);
  for (const [parameters, expected] of [[undefined, "HIGH"], [{ media_resolution: "low" as const }, "LOW"],
    [{ mediaResolution: "MEDIA_RESOLUTION_MEDIUM" }, "MEDIUM"],
    [{ media_resolution: "unspecified" as const }, "UNSPECIFIED"]] as const) {
    const result = await rawGenerate(userId, { provider: "google", model: "gemini-3.8-flash", connection_id: connectionId,
      messages: [{ role: "user", content: [{ type: "image", mime_type: "image/png", data: "PRIVATE_IMAGE_BYTES" }] }],
      reasoning: { source: "inherit" }, parameters });
    expect(result.content).toBe("A small reply.");
    expect(body.generationConfig.mediaResolution).toBe(`MEDIA_RESOLUTION_${expected}`);
    expect(body.generationConfig).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("media_resolution");
  }
});
