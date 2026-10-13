import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import type { LlmMessage } from "../llm/types";
import { DesktopCaptureBroker } from "./desktop-capture-broker";
import { WorkerHostDesktopCaptureApi, type WorkerHostDesktopCaptureContext } from "./worker-host-desktop-capture-api";
import type { DesktopCaptureDestination, DesktopCaptureRequest } from "./desktop-capture-contract";
import { PRIVILEGED_PERMISSIONS } from "./manager.service";
import { GoogleProvider } from "../llm/providers/google";

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
    const messages = [{ role: "user", content: [{ type: "text", text: "React to the clip" },
      { type: "desktop_capture", asset_id: asset.assetId }] }] as unknown as LlmMessage[];
    expect(() => setup.api.prepareGeneration({ type: "raw", connection_id: "connection", messages }, "alice")).toThrow("CAPTURE_DESTINATION_CHANGED");
    const input = { type: "raw", connection_id: "connection", provider: "google", model: "gemini-3.8-flash", messages };
    const prepared = setup.api.prepareGeneration(input, "alice");
    expect(prepared.sensitiveMedia).toBe(true);
    const body = (new GoogleProvider() as any).buildBody({ ...input, messages: prepared.messages, parameters: { max_tokens: 4096 }, tools: [] });
    expect(body.contents[0].parts).toEqual([{ text: "React to the clip" }, { inlineData: { mimeType: "video/mp4", data } }]);
    expect(body.generationConfig.maxOutputTokens).toBe(4096);
    expect(JSON.stringify(body)).not.toContain(asset.assetId);
    expect(() => setup.api.prepareGeneration(input, "alice")).toThrow("CAPTURE_ASSET_UNAVAILABLE");
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
