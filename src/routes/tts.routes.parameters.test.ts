import { expect, mock, test } from "bun:test";
import { buildFishAudioBody } from "../tts/providers/fish-audio";

mock.module("../services/tts.service", () => ({
  synthesize: async (_userId: string, input: { text: string; parameters?: Record<string, unknown> }) => {
    buildFishAudioBody({ ...input, parameters: input.parameters || {}, model: "s2.1-pro", voice: "" });
    return { audioData: new Uint8Array([1, 2, 3]).buffer, contentType: "audio/mpeg" };
  },
}));

const { ttsRoutes } = await import("./tts.routes");

test.each([{ temperature: 1.1 }, { min_chunk_length: -1 }, { normalize: "no" }])(
  "reports invalid Fish settings as a client error: %j",
  async (parameters) => {
    const response = await ttsRoutes.request("/synthesize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "fish-connection", text: "Hello", parameters }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain("requires");
  },
);
