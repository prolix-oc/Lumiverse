import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import type { LlmMessage } from "../llm/types";
import { DesktopCaptureBroker } from "./desktop-capture-broker";
import { WorkerHostDesktopCaptureApi, type WorkerHostDesktopCaptureContext } from "./worker-host-desktop-capture-api";
import type { DesktopCaptureDestination, DesktopCaptureRequest } from "./desktop-capture-contract";
import { PRIVILEGED_PERMISSIONS } from "./manager.service";
import { GoogleProvider } from "../llm/providers/google";
import { ZAIProvider } from "../llm/providers/zai";
import { RequestHistoryStore } from "../services/request-history-store";

const brokers: DesktopCaptureBroker[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.dispose(); });

function fixture() {
  const broker = new DesktopCaptureBroker();
  brokers.push(broker);
  const client = broker.register("alice", { name: "Native", platform: "windows", capabilities: { image: true, video: true, replay: true } });
  const grants = new Set(["screen_capture", "screen_recording", "generation"]);
  const destination: DesktopCaptureDestination = { connectionId: "connection", revision: "revision", provider: "google", model: "vision", endpointOrigin: "https://model.example" };
  const posted: any[] = [];
  const context: WorkerHostDesktopCaptureContext = {
    extensionId: "extension", identifier: "example", name: "Example", declaredPermissions: [...grants],
    hasPermission: (permission) => grants.has(permission), authorize: (permissions) => () => permissions.every((permission) => grants.has(permission)),
    resolveEffectiveUserId: (userId) => userId ?? "alice",
    enforceScopedUser: (userId) => { if (userId !== "alice") throw new Error("USER_SCOPE_DENIED"); },
    resolveDestination: (_userId, id) => { if (id !== "connection") throw new Error("CAPTURE_CONNECTION_REQUIRED"); return { ...destination }; },
    postResponse: (response) => posted.push(response),
  };
  const api = new WorkerHostDesktopCaptureApi(context, broker);
  const input: DesktopCaptureRequest = { deviceId: client.device.id, connectionId: "connection", purpose: "Describe selected content", kind: "image" };
  async function settle() { await Bun.sleep(0); }
  return { broker, client, grants, destination, posted, context, api, input, settle };
}

describe("direct worker desktop capture", () => {
  test("optimization RPC preserves capture grants, private handles and generation destination", async () => {
    const setup = fixture();
    setup.api.handle({ type: "desktop_capture_request", requestId: "capture", input: setup.input }); await setup.settle();
    const command = setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)[0]!;
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
    await setup.broker.complete("alice", setup.client.device.id, setup.client.transportToken, { requestId: command.requestId, outcome: "approved",
      media: { mimeType: "image/png", data: png.toString("base64"), width: 2, height: 2 } }); await setup.settle();
    const ref = setup.posted.find(m => m.requestId === "capture").result;
    const input = { assetId: ref.assetId, connectionId: "connection", kind: "image" as const, maxEdge: 1280, format: "jpeg" as const, quality: 85 };
    for (const permission of ["screen_capture", "generation"]) {
      setup.grants.delete(permission);
      setup.api.handle({ type: "desktop_capture_optimize", requestId: permission, input }); await setup.settle();
      expect(setup.posted.at(-1).error).toContain("permission not granted"); setup.grants.add(permission);
    }
    const response = new Promise<any>(resolve => { setup.context.postResponse = resolve; });
    setup.api.handle({ type: "desktop_capture_optimize", requestId: "optimized", input });
    const reply = await response;
    expect(reply).toMatchObject({ requestId: "optimized", result: { assetId: ref.assetId, mimeType: "image/jpeg", width: 2, height: 2, expiresAt: ref.expiresAt } });
    expect(reply.result.data).toBeUndefined();
    const prepared = setup.api.prepareGeneration({ type: "raw", connection_id: "connection", model: "vision",
      messages: [{ role: "user", content: [{ type: "desktop_capture", asset_id: ref.assetId }] }] as unknown as LlmMessage[] }, "alice");
    expect(prepared.sensitiveMedia).toBe(true);
    expect((prepared.messages[0]!.content as any[])[0].mime_type).toBe("image/jpeg");
  });
  test("finish checks recording and generation grants and enforces the trusted user scope", async () => {
    const setup = fixture();
    setup.api.handle({ type: "desktop_capture_finish", requestId: "finished", requestKey: "already-done" }); await setup.settle();
    expect(setup.posted.at(-1)).toMatchObject({ requestId: "finished", result: false });
    setup.api.handle({ type: "desktop_capture_finish", requestId: "other-user", requestKey: "a", userId: "bob" }); await setup.settle();
    expect(setup.posted.at(-1).error).toBe("USER_SCOPE_DENIED");
    for (const permission of ["screen_recording", "generation"]) {
      setup.grants.delete(permission);
      setup.api.handle({ type: "desktop_capture_finish", requestId: permission, requestKey: "a" }); await setup.settle();
      expect(setup.posted.at(-1).error).toContain("permission not granted");
      setup.grants.add(permission);
    }
  });
  test("regranting permission cannot revive a pending approval-status query", async () => {
    const setup = fixture();
    const native = setup.broker.register("alice", { name: "Native", platform: "macos", approvalStatus: true, capabilities: { image: true, video: false, replay: false } });
    let revision = "grant-before";
    setup.context.grantRevision = () => revision;
    setup.api.handle({ type: "desktop_capture_approval_status", requestId: "status", input: { deviceId: native.device.id, connectionId: "connection", kind: "image" } });
    await setup.settle();
    const command = setup.broker.poll("alice", native.device.id, native.transportToken)[0];
    revision = "grant-after";
    setup.broker.completeInspection("alice", native.device.id, native.transportToken, { requestId: command.requestId, approval: "remembered", source: "ready" });
    await setup.settle();
    expect(setup.posted.at(-1)).toMatchObject({ requestId: "status", error: "CAPTURE_REVOKED" });
  });
  test("approval status is read-only and enforces the same permissions and destination ownership", async () => {
    const setup = fixture();
    const input = { deviceId: setup.client.device.id, connectionId: "connection", kind: "image" as const };
    setup.api.handle({ type: "desktop_capture_approval_status", requestId: "status", input });
    await setup.settle();
    expect(setup.posted.at(-1)).toMatchObject({ requestId: "status", result: { approval: "unknown", source: "unknown" } });
    expect(setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)).toEqual([]);
    setup.grants.delete("generation");
    setup.api.handle({ type: "desktop_capture_approval_status", requestId: "denied", input });
    await setup.settle();
    expect(setup.posted.at(-1).error).toContain("generation");
  });
  test("native approval scopes change after permission regrant without changing asset destination binding", async () => {
    const revisions: string[] = [];
    for (const grant of ["capture-row-a:generation-row-a", "capture-row-b:generation-row-a", "capture-row-a:generation-row-b"]) {
      const setup = fixture();
      setup.context.grantRevision = () => grant;
      setup.api.handle({ type: "desktop_capture_request", requestId: "request", input: setup.input });
      await setup.settle();
      const command = setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)[0];
      expect(command.type).toBe("capture");
      if (command.type !== "capture") throw new Error("Missing capture command");
      expect(command.destination.revision).toBe(setup.destination.revision);
      expect(command.extension.approvalRevision).toMatch(/^[a-f0-9]{64}$/);
      revisions.push(command.extension.approvalRevision!);
    }
    expect(new Set(revisions).size).toBe(3);
  });

  test("capture permissions are never part of the automatic grant tier", () => {
    expect(PRIVILEGED_PERMISSIONS.has("screen_capture")).toBe(true);
    expect(PRIVILEGED_PERMISSIONS.has("screen_recording")).toBe(true);
  });

  test("requires manifest declaration, current grants, and generation permission before requesting native capture", async () => {
    for (const permission of ["screen_capture", "generation"]) {
      const setup = fixture();
      setup.grants.delete(permission);
      setup.api.handle({ type: "desktop_capture_request", requestId: "request", input: setup.input });
      await setup.settle();
      expect(setup.posted[0].error).toContain(permission);
      expect(setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)).toEqual([]);
    }
    const setup = fixture();
    setup.context.declaredPermissions = [];
    setup.api.handle({ type: "desktop_capture_request", requestId: "undeclared", input: setup.input });
    await setup.settle();
    expect(setup.posted[0].error).toContain("screen_capture");
  });

  test("never accepts a user-scoped extension spoofing a different desktop account", async () => {
    const setup = fixture();
    setup.api.handle({ type: "desktop_capture_devices", requestId: "request", userId: "bob" });
    await setup.settle();
    expect(setup.posted[0].error).toBe("USER_SCOPE_DENIED");
  });

  test("fails closed without a registered native capture device", async () => {
    const setup = fixture();
    setup.broker.dispose();
    setup.api.handle({ type: "desktop_capture_devices", requestId: "list" });
    setup.api.handle({ type: "desktop_capture_request", requestId: "request", input: setup.input });
    await setup.settle();
    expect(setup.posted.find((response) => response.requestId === "list").result).toEqual([]);
    expect(setup.posted.find((response) => response.requestId === "request").error).toBe("DESKTOP_UNAVAILABLE");
  });

  test("invalidates authorization if the connection changes while consent is pending", async () => {
    const setup = fixture();
    setup.api.handle({ type: "desktop_capture_request", requestId: "request", input: setup.input });
    await setup.settle();
    const command = setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)[0];
    setup.destination.revision = "changed";
    const data = await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } }).png().toBuffer();
    await expect(setup.broker.complete("alice", setup.client.device.id, setup.client.transportToken, {
      requestId: command.requestId, outcome: "approved", media: { mimeType: "image/png", data: data.toString("base64"), width: 1, height: 1 },
    })).rejects.toThrow("CAPTURE_PERMISSION_REVOKED");
    await setup.settle();
    expect(setup.posted[0].error).toBe("CAPTURE_PERMISSION_REVOKED");
  });

  test("prepares approved references only for the exact raw-generation destination", async () => {
    const setup = fixture();
    setup.api.handle({ type: "desktop_capture_request", requestId: "request", input: setup.input });
    await setup.settle();
    const command = setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)[0];
    const data = await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } }).png().toBuffer();
    await setup.broker.complete("alice", setup.client.device.id, setup.client.transportToken, {
      requestId: command.requestId, outcome: "approved", media: { mimeType: "image/png", data: data.toString("base64"), width: 1, height: 1 },
    });
    await setup.settle();
    const asset = setup.posted[0].result;
    const messages = [{ role: "user", content: [{ type: "desktop_capture", asset_id: asset.assetId }] }] as unknown as LlmMessage[];
    const input = { type: "raw", messages, connection_id: "connection", provider: "google", model: "vision" };
    expect(() => setup.api.prepareGeneration({ ...input, type: "quiet" }, "alice")).toThrow("CAPTURE_REQUIRES_RAW_GENERATION");
    expect(() => setup.api.prepareGeneration({ ...input, model: "other" }, "alice")).toThrow("CAPTURE_DESTINATION_CHANGED");
    expect(() => setup.api.prepareGeneration({ ...input, provider: "other" }, "alice")).toThrow("CAPTURE_DESTINATION_CHANGED");
    expect(() => setup.api.prepareGeneration({ ...input, model: undefined }, "alice")).toThrow("CAPTURE_DESTINATION_CHANGED");
    expect(() => setup.api.prepareGeneration({ ...input, model: "" }, "alice")).toThrow("CAPTURE_DESTINATION_CHANGED");
    expect(() => setup.api.prepareGeneration({ ...input, parameters: { models: ["other"] } }, "alice")).toThrow("CAPTURE_UNSAFE_PARAMETERS");
    expect(() => setup.api.prepareGeneration({ ...input, parameters: { _openrouter: { fallback: true } } }, "alice")).toThrow("CAPTURE_UNSAFE_PARAMETERS");
    expect(() => setup.api.prepareGeneration({ ...input, parameters: { _nanogpt: { model_overrides: { vision: { only: ["other"] } } } } }, "alice")).toThrow("CAPTURE_UNSAFE_PARAMETERS");
    const result = setup.api.prepareGeneration(input, "alice");
    expect(result.sensitiveMedia).toBe(true);
    expect(result.messages[0].content).toEqual([{ type: "image", data: data.toString("base64"), mime_type: "image/png" }]);
    expect(() => setup.api.prepareGeneration(input, "alice")).toThrow("CAPTURE_ASSET_UNAVAILABLE");
  });

  test("binds an approved video to Gemini 3.8 and serializes its private bytes as inlineData", async () => {
    const setup = fixture();
    setup.destination.model = "gemini-3.8-flash";
    setup.api.handle({ type: "desktop_capture_request", requestId: "request", input: {
      ...setup.input, kind: "video", mode: "record", durationSeconds: 3,
    } });
    await setup.settle();
    const command = setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)[0];
    const data = Buffer.from([0, 0, 0, 20, ...Buffer.from("ftypisom")]).toString("base64");
    await setup.broker.complete("alice", setup.client.device.id, setup.client.transportToken, {
      requestId: command.requestId, outcome: "approved", media: { mimeType: "video/mp4", data, width: 640, height: 480, durationSeconds: 3 },
    });
    await setup.settle();
    const asset = setup.posted[0].result;
    const characterPrompt = "You are Koko.\nCharacter description:\nA playful companion.\nPersonality:\nWitty and observant.";
    const question = "Look at this page.\n\nWhat changed in the video?";
    const messages = [{ role: "system", content: characterPrompt }, { role: "user", content: [{ type: "text", text: question },
      { type: "desktop_capture", asset_id: asset.assetId }] }] as unknown as LlmMessage[];
    expect(() => setup.api.prepareGeneration({ type: "raw", connection_id: "connection", messages }, "alice")).toThrow("CAPTURE_DESTINATION_CHANGED");
    const input = { type: "raw", connection_id: "connection", provider: "google", model: "gemini-3.8-flash", messages };
    const prepared = setup.api.prepareGeneration(input, "alice");
    expect(prepared.sensitiveMedia).toBe(true);
    const body = (new GoogleProvider() as any).buildBody({ ...input, messages: prepared.messages, parameters: { max_tokens: 4096 }, tools: [] });
    expect(body.systemInstruction.parts).toEqual([{ text: characterPrompt }]);
    expect(body.contents[0].parts).toEqual([{ text: question }, { inlineData: { mimeType: "video/mp4", data } }]);
    expect(body.generationConfig.maxOutputTokens).toBe(4096);
    expect(JSON.stringify(body)).not.toContain(asset.assetId);
    expect(() => setup.api.prepareGeneration(input, "alice")).toThrow("CAPTURE_ASSET_UNAVAILABLE");
  });

  test("Z.ai receives an authorized GLM video with character context and speech while history omits media", async () => {
    const setup = fixture();
    setup.destination.provider = "zai";
    setup.destination.model = "glm-5.3-flash";
    setup.api.handle({ type: "desktop_capture_request", requestId: "glm-video", input: {
      ...setup.input, kind: "video", mode: "record", durationSeconds: 3,
    } });
    await setup.settle();
    const command = setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)[0];
    expect(command).toMatchObject({ type: "capture", kind: "video", destination: { provider: "zai", model: "glm-5.3-flash" } });
    const data = Buffer.from([0, 0, 0, 20, ...Buffer.from("ftypisom")]).toString("base64");
    await setup.broker.complete("alice", setup.client.device.id, setup.client.transportToken, {
      requestId: command.requestId, outcome: "approved", media: { mimeType: "video/mp4", data, width: 640, height: 480, durationSeconds: 3 },
    });
    await setup.settle();
    const asset = setup.posted[0].result;
    const input = { type: "raw", connection_id: "connection", provider: "zai", model: "glm-5.3-flash", messages: [
      { role: "system", content: "You are Aster. Description: a reserved scholar. Personality: dry and precise." },
      { role: "user", content: "Ready?" }, { role: "assistant", content: "Proceed." },
      { role: "user", content: [{ type: "text", text: "Typed context\n\nTranscribed question" }, { type: "desktop_capture", asset_id: asset.assetId }] },
    ] as unknown as LlmMessage[] };
    const prepared = setup.api.prepareGeneration(input, "alice");
    const body = (new ZAIProvider() as any).buildBody({ ...input, messages: prepared.messages, parameters: {}, tools: [] }, true);
    expect(body.messages[0].content).toContain("reserved scholar");
    expect(body.messages[2].content).toBe("Proceed.");
    expect(body.messages.at(-1).content).toEqual([
      { type: "text", text: "Typed context\n\nTranscribed question" },
      { type: "video_url", video_url: { url: `data:video/mp4;base64,${data}` } },
    ]);
    const history = new RequestHistoryStore();
    const id = history.record("alice", { origin: { kind: "extension", name: "Desk Companion", sensitiveMedia: true } }, {
      provider: "zai", model: "glm-5.3-flash", body: JSON.stringify(body), credentials: [],
    })!;
    const logged = history.get("alice", id)!.bodyJson!;
    expect(logged).toContain("reserved scholar");
    expect(logged).toContain("Transcribed question");
    expect(logged).not.toContain(data);
    expect(logged).not.toContain(asset.assetId);
    expect(() => setup.api.prepareGeneration(input, "alice")).toThrow("CAPTURE_ASSET_UNAVAILABLE");
  });

  test("rejects text-only or unknown GLM variants before recording, while accepting documented FlashX variants", async () => {
    for (const model of ["glm-5.3", "glm-5.2", "glm-4.7", "glm-5.3-flash-fictional"]) {
      const setup = fixture(); setup.destination.provider = "zai"; setup.destination.model = model;
      setup.api.handle({ type: "desktop_capture_request", requestId: "unsupported-glm", input: {
        ...setup.input, kind: "video", mode: "record", durationSeconds: 3,
      } });
      await setup.settle();
      expect(setup.posted[0].error).toBe("CAPTURE_PROVIDER_UNSUPPORTED");
      expect(setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)).toEqual([]);
    }
    for (const model of ["glm-5.3-flashx", "glm-5.3-flashx-legal"]) {
      const setup = fixture(); setup.destination.provider = "zai"; setup.destination.model = model;
      setup.api.handle({ type: "desktop_capture_request", requestId: "flashx", input: {
        ...setup.input, kind: "video", mode: "record", durationSeconds: 3,
      } });
      await setup.settle();
      expect(setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)[0]).toMatchObject({ kind: "video" });
    }
  });

  test("does not queue video for an adapter that would discard it", async () => {
    const setup = fixture();
    setup.destination.provider = "openai";
    setup.api.handle({ type: "desktop_capture_request", requestId: "request", input: {
      ...setup.input, kind: "video", mode: "record", durationSeconds: 5,
    } });
    await setup.settle();
    expect(setup.posted[0].error).toBe("CAPTURE_PROVIDER_UNSUPPORTED");
    expect(setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)).toEqual([]);
  });

  test("Vertex partner protocols cannot inherit Gemini video support", async () => {
    const setup = fixture();
    setup.destination.provider = "google_vertex";
    setup.destination.model = "claude-sonnet-4-6";
    setup.api.handle({ type: "desktop_capture_request", requestId: "request", input: {
      ...setup.input, kind: "video", mode: "record", durationSeconds: 5,
    } });
    await setup.settle();
    expect(setup.posted[0].error).toBe("CAPTURE_PROVIDER_UNSUPPORTED");
    expect(setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)).toEqual([]);
    setup.destination.model = "gemini-2.5-flash";
    setup.api.handle({ type: "desktop_capture_request", requestId: "gemini", input: {
      ...setup.input, kind: "video", mode: "record", durationSeconds: 5,
    } });
    await setup.settle();
    expect(setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)[0]).toMatchObject({ type: "capture", kind: "video" });
  });

  test("revoke completes pending worker requests with an error", async () => {
    const setup = fixture();
    setup.api.handle({ type: "desktop_capture_request", requestId: "request", input: setup.input });
    await setup.settle();
    setup.api.revoke();
    await setup.settle();
    expect(setup.posted[0].error).toBe("CAPTURE_REVOKED");
  });

  test("unload before a queued RPC executes prevents a new native prompt", async () => {
    const setup = fixture();
    setup.api.handle({ type: "desktop_capture_request", requestId: "request", input: setup.input });
    setup.api.dispose();
    await setup.settle();
    expect(setup.posted[0].error).toBe("CAPTURE_REVOKED");
    expect(setup.broker.poll("alice", setup.client.device.id, setup.client.transportToken)).toEqual([]);
    setup.api.handle({ type: "desktop_capture_devices", requestId: "stopped" });
    await setup.settle();
    expect(setup.posted[1].error).toBe("CAPTURE_REVOKED");
  });
});
