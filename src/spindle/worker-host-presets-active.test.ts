import { afterEach, expect, spyOn, test } from "bun:test";
import * as presetProfiles from "../services/preset-profiles.service";
import { WorkerHostStateApi } from "./worker-host-state-api";

let resolveSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => resolveSpy?.mockRestore());

function createApi(allow: boolean) {
  const responses: Array<{ requestId: string; result?: any; error?: string }> = [];
  const api = new WorkerHostStateApi({
    getChatOwnerId: () => "owner",
    enforceScopedUser: (id) => { if (id !== "owner") throw new Error("Wrong user"); },
    resolveEffectiveUserId: (id) => id ?? "owner",
    hasPermission: () => allow,
    postResponse: (message) => responses.push(message),
  });
  return { api, responses };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("presets.getActive requires the presets permission", async () => {
  resolveSpy = spyOn(presetProfiles, "resolveActivePreset");
  const { api, responses } = createApi(false);
  expect(api.dispatch({ type: "presets_get_active", requestId: "denied", chatId: "chat-1" })).toBe(true);
  await settle();
  expect(responses[0].error).toContain("presets");
  expect(resolveSpy).not.toHaveBeenCalled();
});

test("presets.getActive returns the resolved preset, scope and block states", async () => {
  resolveSpy = spyOn(presetProfiles, "resolveActivePreset").mockResolvedValue({
    preset_id: "preset-2",
    binding: { preset_id: "preset-2", block_states: { a: false }, captured_at: 1 },
    source: "chat",
    source_id: "chat-1",
  });
  const { api, responses } = createApi(true);
  api.dispatch({ type: "presets_get_active", requestId: "ok", chatId: "chat-1" });
  await settle();
  expect(resolveSpy).toHaveBeenCalledWith("owner", "chat-1");
  expect(responses[0].result).toEqual({
    preset_id: "preset-2", source: "chat", source_id: "chat-1", block_states: { a: false },
  });
});

test("presets.getActive reports unknown chats and other users", async () => {
  resolveSpy = spyOn(presetProfiles, "resolveActivePreset").mockResolvedValue(null);
  const { api, responses } = createApi(true);
  api.dispatch({ type: "presets_get_active", requestId: "missing", chatId: "missing" });
  api.dispatch({ type: "presets_get_active", requestId: "foreign", chatId: "chat-1", userId: "other" });
  await settle();
  expect(responses.find((r) => r.requestId === "missing")?.error).toBe("Chat not found");
  expect(responses.find((r) => r.requestId === "foreign")?.error).toBe("Wrong user");
});
