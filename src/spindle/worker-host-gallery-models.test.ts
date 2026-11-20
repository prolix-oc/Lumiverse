import { afterEach, expect, spyOn, test } from "bun:test";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import * as characterGallerySvc from "../services/character-gallery.service";
import * as charactersSvc from "../services/characters.service";
import * as imagesSvc from "../services/images.service";
import * as connectionsSvc from "../services/connections.service";
import { WorkerHost } from "./worker-host";

type Options = { scope?: "user" | "operator"; granted?: string[] };

function invoke(message: Record<string, unknown>, options: Options = {}): Promise<any> {
  const host = new WorkerHost("gallery-models-test", {
    identifier: "gallery-models-test", name: "Gallery and models test",
  } as SpindleManifest, {
    id: "gallery-models-test", identifier: "gallery-models-test", name: "Gallery and models test",
    version: "0.0.0", author: "", description: "", github: "", homepage: "",
    permissions: [], granted_permissions: [], enabled: true, installed_at: 0, updated_at: 0,
    has_frontend: false, has_backend: false, status: "stopped",
    metadata: { install_scope: options.scope ?? "user", installed_by_user_id: "alice" },
  } satisfies ExtensionInfo);
  const internal = host as unknown as {
    hasPermission(permission: string): boolean;
    handleMessage(message: unknown): void;
    runtime: { mode: string; pid: null; postMessage(message: unknown): void; terminate(): void };
  };
  const granted = options.granted ?? ["characters", "generation"];
  internal.hasPermission = (permission) => granted.includes(permission);
  return new Promise((resolve) => {
    internal.runtime = { mode: "worker", pid: null, postMessage: resolve, terminate() {} };
    internal.handleMessage({ requestId: "request", ...message });
  });
}

const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of restores.splice(0)) spy.mockRestore();
});

test("characters.getGallery returns the owner's gallery as DTOs", async () => {
  const listGallery = spyOn(characterGallerySvc, "listGallery").mockReturnValue([{
    id: "item-1", image_id: "image-1", reference: "gallery://1", caption: "Smile",
    sort_order: 0, created_at: 10, width: 512, height: 768, mime_type: "image/png",
    internal: "not exposed",
  } as any]);
  restores.push(listGallery);

  const response = await invoke({ type: "characters_get_gallery", characterId: "char-1" });
  expect(response.error).toBeUndefined();
  expect(response.result).toEqual([{
    id: "item-1", image_id: "image-1", reference: "gallery://1", caption: "Smile",
    sort_order: 0, created_at: 10, width: 512, height: 768, mime_type: "image/png",
  }]);
  expect(listGallery).toHaveBeenCalledWith("alice", "char-1", { registerReferences: false });
});

test("characters.getGallery enforces the characters permission and user scope", async () => {
  const listGallery = spyOn(characterGallerySvc, "listGallery").mockReturnValue([]);
  restores.push(listGallery);

  expect((await invoke({ type: "characters_get_gallery", characterId: "c" }, { granted: ["generation"] })).error).toContain("characters");
  expect((await invoke({ type: "characters_get_gallery", characterId: "c" }, { scope: "operator" })).error).toContain("userId is required");
  expect((await invoke({ type: "characters_get_gallery", characterId: "c", userId: "bob" })).result).toEqual([]);
  expect((await invoke({ type: "characters_get_gallery", characterId: "c", userId: "bob" }, { scope: "operator" })).result).toEqual([]);
  expect(listGallery.mock.calls.map((call) => call[0])).toEqual(["alice", "bob"]);
});

test("connections.getModels maps the model list to id/label pairs", async () => {
  const listModels = spyOn(connectionsSvc, "listConnectionModels").mockResolvedValue({
    models: ["gpt-a", "gpt-b"], model_labels: { "gpt-b": "GPT B" }, provider: "openrouter",
  });
  restores.push(listModels);

  const response = await invoke({ type: "connections_models", connectionId: "conn-1" });
  expect(response.error).toBeUndefined();
  expect(response.result).toEqual([{ id: "gpt-a", label: "gpt-a" }, { id: "gpt-b", label: "GPT B" }]);
  expect(listModels).toHaveBeenCalledWith("alice", "conn-1");
});

test("connections.getModels surfaces provider errors and enforces generation permission and scope", async () => {
  const listModels = spyOn(connectionsSvc, "listConnectionModels").mockResolvedValue({
    models: [], provider: "", error: "Connection not found",
  });
  restores.push(listModels);

  expect((await invoke({ type: "connections_models", connectionId: "missing" })).error).toBe("Connection not found");
  expect((await invoke({ type: "connections_models", connectionId: "c" }, { granted: ["characters"] })).error).toContain("generation");
  expect((await invoke({ type: "connections_models", connectionId: "c" }, { scope: "operator" })).error).toContain("userId is required");
  expect(listModels).toHaveBeenCalledTimes(1);
});

test("connections.getModels safely labels model IDs that match Object prototype properties", async () => {
  const models = ["constructor", "__proto__", "toString", "hasOwnProperty"];
  const listModels = spyOn(connectionsSvc, "listConnectionModels").mockResolvedValue({ models, provider: "custom" });
  restores.push(listModels);

  const response = await invoke({ type: "connections_models", connectionId: "conn-1" });
  expect(response.error).toBeUndefined();
  expect(response.result).toEqual(models.map((id) => ({ id, label: id })));
  expect(() => structuredClone(response)).not.toThrow();
});

test("connections.getModels uses only own nonempty string labels", async () => {
  const labels = Object.assign(Object.create({ inherited: "Inherited label" }), {
    named: "Display name", empty: "", invalid: { name: "Not a string" },
  });
  const listModels = spyOn(connectionsSvc, "listConnectionModels").mockResolvedValue({
    models: ["inherited", "named", "empty", "invalid"], model_labels: labels, provider: "openrouter",
  });
  restores.push(listModels);

  const response = await invoke({ type: "connections_models", connectionId: "conn-1" });
  expect(response.error).toBeUndefined();
  expect(response.result).toEqual([
    { id: "inherited", label: "inherited" },
    { id: "named", label: "Display name" },
    { id: "empty", label: "empty" },
    { id: "invalid", label: "invalid" },
  ]);
});


test("character search passes scoped pagination and projects an owned thumbnail without Images permission", async () => {
  const character = { id: "c", user_id: "alice", name: "Mira", image_id: "portrait", extensions: {}, internal: "private" };
  const summaries = spyOn(charactersSvc, "listCharacterSummaries").mockReturnValue({ data: [{ id: "c" }], total: 61 } as any);
  const get = spyOn(charactersSvc, "getCharacter").mockReturnValue(character as any);
  const image = spyOn(imagesSvc, "getImage").mockReturnValue({ url: "/thumbnail.png" } as any);
  restores.push(summaries, get, image);
  const response = await invoke({ type: "characters_list", search: "Mira", limit: 50, offset: 50 });
  expect(response.error).toBeUndefined();
  expect(summaries).toHaveBeenCalledWith("alice", { limit: 50, offset: 50 }, { search: "Mira" });
  expect(get).toHaveBeenCalledWith("alice", "c");
  expect(image).toHaveBeenCalledWith("alice", "portrait", { specificity: "sm" });
  expect(response.result).toMatchObject({ total: 61, data: [{ id: "c", avatar_url: "/thumbnail.png" }] });
  expect(response.result.data[0].internal).toBeUndefined();
  expect(response.result.data[0].user_id).toBeUndefined();
  image.mockReturnValue(null);
  expect((await invoke({ type: "characters_get", characterId: "c" })).result.avatar_url).toBeNull();
});

test("character search rejects oversized queries and enforces Characters permission and scope", async () => {
  const summaries = spyOn(charactersSvc, "listCharacterSummaries").mockReturnValue({ data: [], total: 0 } as any);
  restores.push(summaries);
  expect((await invoke({ type: "characters_list", search: "x".repeat(201) })).error).toContain("200");
  expect((await invoke({ type: "characters_list", search: "Mira" }, { granted: ["generation"] })).error).toContain("characters");
  expect((await invoke({ type: "characters_list", search: "Mira" }, { scope: "operator" })).error).toContain("userId is required");
  expect(summaries).not.toHaveBeenCalled();
  await invoke({ type: "characters_list", search: "Mira", userId: "bob" });
  await invoke({ type: "characters_list", search: "Mira", userId: "bob" }, { scope: "operator" });
  expect(summaries.mock.calls.map(call => call[0])).toEqual(["alice", "bob"]);
});
