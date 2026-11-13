import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import type { LlmMessage } from "../llm/types";
import { DesktopCaptureBroker, DESKTOP_CAPTURE_LIMITS, type DesktopCaptureOwner } from "./desktop-capture-broker";
import type { DesktopCaptureDestination, DesktopCaptureReply, DesktopCaptureRequest } from "./desktop-capture-contract";

const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "white" } }).png().toBuffer();
const brokers: DesktopCaptureBroker[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.dispose(); });

function fixture() {
  let now = 1000;
  const broker = new DesktopCaptureBroker({ now: () => now });
  brokers.push(broker);
  const owner: DesktopCaptureOwner = { runtimeId: "runtime", extensionId: "extension", identifier: "example.extension", name: "Example", userId: "alice" };
  const destination: DesktopCaptureDestination = { connectionId: "connection", revision: "revision", provider: "google", model: "vision", endpointOrigin: "https://model.example" };
  const client = broker.register("alice", { name: "Desktop", platform: "macos", capabilities: { image: true, video: true, replay: true } });
  const input: DesktopCaptureRequest = { deviceId: client.device.id, connectionId: "connection", purpose: "Describe the selected window", kind: "image" };
  function request(authorized = () => true, requestInput = input) {
    const promise = broker.request(owner, requestInput, destination, authorized);
    void promise.catch(() => {});
    return promise;
  }
  function poll() { return broker.poll("alice", client.device.id, client.transportToken); }
  function reply(requestId: string): DesktopCaptureReply {
    return { requestId, outcome: "approved", media: { mimeType: "image/png", data: png.toString("base64"), width: 2, height: 2 } };
  }
  async function complete(requestId: string, response = reply(requestId)) {
    await broker.complete("alice", client.device.id, client.transportToken, response);
  }
  function messages(assetId: string): LlmMessage[] {
    return [{ role: "user", content: [{ type: "desktop_capture", asset_id: assetId }] }] as unknown as LlmMessage[];
  }
  return { broker, owner, destination, client, input, request, poll, reply, complete, messages, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe("native desktop capture broker", () => {
  test("allows two-minute clips and bounded large uploads that outlast a polling lease", async () => {
    const setup = fixture();
    const promise = setup.request(() => true, { ...setup.input, kind: "video", mode: "record", durationSeconds: 120 });
    const command = setup.poll()[0];
    expect(command).toMatchObject({ kind: "video", durationSeconds: 120, maxBytes: 128 * 1024 * 1024, expiresAt: 301000 });
    expect(DESKTOP_CAPTURE_LIMITS.totalBytes).toBe(256 * 1024 * 1024);
    await setup.broker.receive("alice", setup.client.device.id, setup.client.transportToken, async maxBytes => {
      expect(maxBytes).toBe(Math.ceil(128 * 1024 * 1024 / 3) * 4 + 4096);
      setup.advance(60_000);
      return { requestId: command.requestId, outcome: "approved", media: {
        mimeType: "video/mp4", data: Buffer.from("0000ftyp0000").toString("base64"), width: 1920, height: 1080, durationSeconds: 120,
      } };
    });
    expect(await promise).toMatchObject({ kind: "video", durationSeconds: 120 });
  });

  test("finish is scoped, idempotent and resolves the original request with only the shorter clip", async () => {
    const setup = fixture();
    const native = setup.broker.register("alice", { name: "Windows", platform: "windows", recordingControl: true, capabilities: { image: true, video: true, replay: false } });
    expect(native.device.recordingControlSupported).toBe(true);
    const promise = setup.request(() => true, { ...setup.input, deviceId: native.device.id, kind: "video", mode: "record", durationSeconds: 30, requestKey: "share-a" });
    for (const change of [{ userId: "bob" }, { runtimeId: "other-runtime" }, { extensionId: "other-extension" }]) {
      expect(setup.broker.finish({ ...setup.owner, ...change }, "share-a")).toBe(false);
    }
    expect(setup.broker.finish(setup.owner, "share-a")).toBe(true);
    expect(setup.broker.finish(setup.owner, "share-a")).toBe(true);
    const commands = setup.broker.poll("alice", native.device.id, native.transportToken);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({ type: "capture", kind: "video", durationSeconds: 30 });
    expect(commands[1]).toEqual({ type: "finish", requestId: commands[0]!.requestId });
    expect(setup.broker.poll("alice", native.device.id, native.transportToken)).toEqual([]);
    const media = { mimeType: "video/mp4", data: Buffer.from("0000ftyp0000").toString("base64"), width: 2, height: 2, durationSeconds: 2.5 };
    await setup.broker.complete("alice", native.device.id, native.transportToken, { requestId: commands[0]!.requestId, outcome: "approved", media });
    expect(await promise).toMatchObject({ kind: "video", durationSeconds: 2.5 });
    expect(setup.broker.finish(setup.owner, "share-a")).toBe(false);
  });

  test("legacy clients keep their duration cutoff and malformed controls never change a capture", () => {
    const setup = fixture();
    for (const requestKey of ["../capture", "x".repeat(129), null, 42]) {
      expect(() => setup.request(() => true, { ...setup.input, requestKey } as any)).toThrow("INVALID_CAPTURE_REQUEST");
    }
    setup.request(() => true, { ...setup.input, kind: "video", mode: "record", durationSeconds: 10, requestKey: "legacy" });
    expect(() => setup.broker.finish(setup.owner, "legacy")).toThrow("CAPTURE_FINISH_UNSUPPORTED");
    expect(() => setup.broker.finish(setup.owner, "../capture")).toThrow("INVALID_CAPTURE_REQUEST");
    expect(setup.poll().map(command => command.type)).toEqual(["capture"]);
  });

  test("revoked authorization cancels rather than finalizes the pending clip", async () => {
    const setup = fixture(); let authorized = true;
    const native = setup.broker.register("alice", { name: "Windows", platform: "windows", recordingControl: true, capabilities: { image: true, video: true, replay: false } });
    const promise = setup.request(() => authorized, { ...setup.input, deviceId: native.device.id, kind: "video", mode: "record", durationSeconds: 30, requestKey: "revoked" });
    authorized = false;
    expect(() => setup.broker.finish(setup.owner, "revoked")).toThrow("CAPTURE_REVOKED");
    await expect(promise).rejects.toThrow("CAPTURE_REVOKED");
    expect(setup.broker.poll("alice", native.device.id, native.transportToken).some(command => command.type === "finish")).toBe(false);
  });
  test("publishes all three displays with private leases and routes capture and approval to the exact display", async () => {
    const setup = fixture();
    const native = setup.broker.register("alice", { name: "Windows", platform: "windows", approvalStatus: true, capabilities: { image: true, video: true, replay: false } });
    const displays = ["a", "b", "c"].map((id, index) => ({ id: id.repeat(64), name: `Display ${index + 1}`, width: 1920, height: 1080, primary: index === 0 }));
    expect(() => setup.broker.updateDisplays("bob", native.device.id, native.transportToken, displays)).toThrow("INVALID_DEVICE_LEASE");
    expect(() => setup.broker.updateDisplays("alice", native.device.id, "forged", displays)).toThrow("INVALID_DEVICE_LEASE");
    setup.broker.updateDisplays("alice", native.device.id, native.transportToken, displays.map(display => ({ ...display, privateHandle: "SECRET" })));
    expect(setup.broker.listDevices("alice").find(device => device.id === native.device.id)?.displays).toEqual(displays);
    expect(setup.broker.listDevices("bob")).toEqual([]);
    const query = setup.broker.inspect(setup.owner, { deviceId: native.device.id, displayId: displays[1].id, connectionId: "connection", kind: "image" }, setup.destination, () => true);
    const command = setup.broker.poll("alice", native.device.id, native.transportToken)[0];
    expect(command).toMatchObject({ type: "approval_status", displayId: displays[1].id });
    setup.broker.completeInspection("alice", native.device.id, native.transportToken, { requestId: command.requestId, approval: "required", source: "unknown" });
    expect(await query).toMatchObject({ displayId: displays[1].id, approval: "required" });
    const pending = setup.request(() => true, { ...setup.input, deviceId: native.device.id, displayId: displays[2].id });
    expect(setup.broker.poll("alice", native.device.id, native.transportToken)[0]).toMatchObject({ type: "capture", displayId: displays[2].id });
    setup.broker.updateDisplays("alice", native.device.id, native.transportToken, displays.slice(0, 2));
    await expect(pending).rejects.toThrow("CAPTURE_DISPLAY_UNAVAILABLE");
    expect(() => setup.request(() => true, { ...setup.input, deviceId: native.device.id, displayId: displays[2].id })).toThrow("CAPTURE_DISPLAY_UNAVAILABLE");
    expect(() => setup.request(() => true, { ...setup.input, displayId: displays[0].id })).toThrow("CAPTURE_DISPLAY_UNAVAILABLE");
  });

  test("rejects invalid and duplicate display metadata without replacing the current topology", () => {
    const setup = fixture();
    const display = { id: "a".repeat(64), name: "Display 1", width: 1920, height: 1080, primary: true };
    setup.broker.updateDisplays("alice", setup.client.device.id, setup.client.transportToken, [display]);
    for (const invalid of [[display, display], [{ ...display, id: "native-handle" }], [{ ...display, width: 0 }],
      [{ ...display, name: "bad\u202elabel" }], new Array(17).fill(display), null]) {
      expect(() => setup.broker.updateDisplays("alice", setup.client.device.id, setup.client.transportToken, invalid)).toThrow("INVALID_DISPLAYS");
      expect(setup.broker.listDevices("alice")[0].displays).toEqual([display]);
    }
  });
  test("late upload cleanup from an old lease cannot block or unlock a replacement lease", async () => {
    const setup = fixture();
    const descriptor = { name: "Native", platform: "macos", deviceKey: "b".repeat(64), capabilities: { image: true, video: false, replay: false } };
    const old = setup.broker.register("alice", descriptor);
    const oldCapture = setup.broker.request(setup.owner, { ...setup.input, deviceId: old.device.id }, setup.destination, () => true);
    void oldCapture.catch(() => {});
    const oldCommand = setup.broker.poll("alice", old.device.id, old.transportToken)[0];
    let finishOld!: (reply: unknown) => void;
    const oldUpload = setup.broker.receive("alice", old.device.id, old.transportToken, () => new Promise(resolve => { finishOld = resolve; }));
    void oldUpload.catch(() => {});
    const next = setup.broker.register("alice", descriptor);
    setup.advance(5001);
    const capture = setup.broker.request(setup.owner, { ...setup.input, deviceId: next.device.id }, setup.destination, () => true);
    void capture.catch(() => {});
    const command = setup.broker.poll("alice", next.device.id, next.transportToken)[0];
    let finishNew!: (reply: unknown) => void;
    const upload = setup.broker.receive("alice", next.device.id, next.transportToken, () => new Promise(resolve => { finishNew = resolve; }));
    finishOld(setup.reply(oldCommand.requestId));
    await expect(oldUpload).rejects.toThrow("INVALID_DEVICE_LEASE");
    await expect(setup.broker.receive("alice", next.device.id, next.transportToken, async () => ({}))).rejects.toThrow("CAPTURE_BUSY");
    finishNew(setup.reply(command.requestId));
    await upload;
    expect((await capture).kind).toBe("image");
    await expect(oldCapture).rejects.toThrow("DESKTOP_DISCONNECTED");
  });
  test("persistent identity survives reconnects while leases and interrupted work are replaced", async () => {
    const setup = fixture();
    const descriptor = { name: "Native", platform: "macos", deviceKey: "a".repeat(64), approvalStatus: true, capabilities: { image: true, video: true, replay: false } };
    const first = setup.broker.register("alice", descriptor);
    const input = { ...setup.input, deviceId: first.device.id };
    const pending = setup.broker.request(setup.owner, input, setup.destination, () => true);
    void pending.catch(() => {});
    setup.broker.poll("alice", first.device.id, first.transportToken);
    const second = setup.broker.register("alice", descriptor);
    await expect(pending).rejects.toThrow("DESKTOP_DISCONNECTED");
    expect(second.device.id).toBe(first.device.id);
    expect(second.device.stableIdentity).toBe(true);
    expect(second.transportToken).not.toBe(first.transportToken);
    expect(second.device).not.toHaveProperty("deviceKey");
    expect(() => setup.broker.poll("alice", first.device.id, first.transportToken)).toThrow("INVALID_DEVICE_LEASE");
    expect(setup.broker.poll("alice", second.device.id, second.transportToken)).toEqual([]);
    expect(setup.broker.register("bob", descriptor).device.id).not.toBe(second.device.id);
  });

  test("approval discovery returns only scoped native metadata and rechecks authorization", async () => {
    const setup = fixture();
    const native = setup.broker.register("alice", { name: "Native", platform: "macos", approvalStatus: true, capabilities: { image: true, video: false, replay: false } });
    const input = { deviceId: native.device.id, connectionId: "connection", kind: "image" as const };
    let authorized = true;
    const first = setup.broker.inspect(setup.owner, input, setup.destination, () => authorized);
    const command = setup.broker.poll("alice", native.device.id, native.transportToken)[0];
    expect(command.type).toBe("approval_status");
    expect(command).not.toHaveProperty("purpose");
    expect(command).not.toHaveProperty("maxBytes");
    expect(() => setup.broker.completeInspection("bob", native.device.id, native.transportToken, { requestId: command.requestId, approval: "remembered", source: "ready" })).toThrow("INVALID_DEVICE_LEASE");
    setup.broker.completeInspection("alice", native.device.id, native.transportToken, { requestId: command.requestId, approval: "remembered", source: "ready", secretSource: "must not escape" });
    expect(await first).toEqual({ deviceId: native.device.id, kind: "image", approval: "remembered", source: "ready", checkedAt: 1000 });
    const next = setup.broker.inspect(setup.owner, input, setup.destination, () => authorized);
    void next.catch(() => {});
    const second = setup.broker.poll("alice", native.device.id, native.transportToken)[0];
    authorized = false;
    setup.broker.completeInspection("alice", native.device.id, native.transportToken, { requestId: second.requestId, approval: "remembered", source: "ready" });
    await expect(next).rejects.toThrow("CAPTURE_REVOKED");
  });

  test("old clients report unknown approval without receiving an unsupported command", async () => {
    const setup = fixture();
    const status = await setup.broker.inspect(setup.owner, { deviceId: setup.client.device.id, connectionId: "connection", kind: "image" }, setup.destination, () => true);
    expect(status.approval).toBe("unknown");
    expect(setup.poll()).toEqual([]);
  });
  test("uses private user/device leases and delivers commands only once", () => {
    const setup = fixture();
    expect(setup.broker.listDevices("bob")).toEqual([]);
    expect(setup.broker.listDevices("alice")[0]).not.toHaveProperty("transportToken");
    expect(() => setup.broker.poll("bob", setup.client.device.id, setup.client.transportToken)).toThrow("INVALID_DEVICE_LEASE");
    expect(() => setup.broker.poll("alice", setup.client.device.id, "forged")).toThrow("INVALID_DEVICE_LEASE");
    setup.request();
    expect(setup.poll()).toHaveLength(1);
    expect(setup.poll()).toEqual([]);
  });

  test("returns metadata only and resolves a handle once for the approved destination", async () => {
    const setup = fixture();
    const promise = setup.request();
    const command = setup.poll()[0];
    expect(command).toMatchObject({ type: "capture", extension: { id: "extension" }, destination: { model: "vision" } });
    expect(command).toHaveProperty("destination.revision", setup.destination.revision);
    await setup.complete(command.requestId);
    const asset = await promise;
    expect(asset).not.toHaveProperty("data");
    expect(asset).not.toHaveProperty("destination");
    const resolved = setup.broker.resolveMessages(setup.owner, setup.messages(asset.assetId), setup.destination, () => true);
    expect(resolved[0].content).toEqual([{ type: "image", mime_type: "image/png", data: png.toString("base64") }]);
    expect(() => setup.broker.resolveMessages(setup.owner, setup.messages(asset.assetId), setup.destination, () => true)).toThrow("CAPTURE_ASSET_UNAVAILABLE");
  });

  test("rejects cross-runtime, cross-extension, cross-user, and changed-destination handles without consuming them", async () => {
    const setup = fixture();
    const promise = setup.request();
    await setup.complete(setup.poll()[0].requestId);
    const asset = await promise;
    for (const owner of [{ ...setup.owner, runtimeId: "other" }, { ...setup.owner, extensionId: "other" }, { ...setup.owner, userId: "bob" }]) {
      expect(() => setup.broker.resolveMessages(owner, setup.messages(asset.assetId), setup.destination, () => true)).toThrow("CAPTURE_ASSET_UNAVAILABLE");
    }
    expect(() => setup.broker.resolveMessages(setup.owner, setup.messages(asset.assetId), { ...setup.destination, revision: "changed" }, () => true)).toThrow("CAPTURE_DESTINATION_CHANGED");
    expect(() => setup.broker.resolveMessages(setup.owner, setup.messages(asset.assetId), setup.destination, () => false)).toThrow("CAPTURE_PERMISSION_REVOKED");
    setup.broker.release(setup.owner, asset.assetId);
  });

  test("resolves duplicate references atomically and does not consume valid handles alongside a forged one", async () => {
    const setup = fixture();
    const promise = setup.request();
    await setup.complete(setup.poll()[0].requestId);
    const asset = await promise;
    expect(() => setup.broker.resolveMessages(setup.owner, [...setup.messages(asset.assetId), ...setup.messages("forged")], setup.destination, () => true)).toThrow("CAPTURE_ASSET_UNAVAILABLE");
    expect(setup.broker.resolveMessages(setup.owner, [...setup.messages(asset.assetId), ...setup.messages(asset.assetId)], setup.destination, () => true)).toHaveLength(2);
  });

  test("rechecks grants when pixels arrive and refuses late replies after revocation", async () => {
    const setup = fixture();
    let authorized = true;
    const promise = setup.request(() => authorized);
    const command = setup.poll()[0];
    authorized = false;
    await expect(setup.complete(command.requestId)).rejects.toThrow("CAPTURE_PERMISSION_REVOKED");
    await expect(promise).rejects.toThrow("CAPTURE_PERMISSION_REVOKED");
    await expect(setup.complete(command.requestId)).rejects.toThrow("UNKNOWN_CAPTURE_REQUEST");
    expect(setup.poll()).toEqual([{ type: "cancel", requestId: command.requestId }]);
  });

  test("runtime cleanup cancels consent requests and invalidates retained assets", async () => {
    const setup = fixture();
    const first = setup.request();
    await setup.complete(setup.poll()[0].requestId);
    const asset = await first;
    setup.advance(5001);
    const second = setup.request();
    setup.broker.revokeRuntime(setup.owner.runtimeId);
    await expect(second).rejects.toThrow("CAPTURE_REVOKED");
    expect(() => setup.broker.release(setup.owner, asset.assetId)).toThrow("CAPTURE_ASSET_UNAVAILABLE");
  });

  test("revocation during asynchronous image validation cannot publish a stale asset", async () => {
    const setup = fixture();
    const promise = setup.request();
    const requestId = setup.poll()[0].requestId;
    const completion = setup.complete(requestId);
    setup.broker.revokeRuntime(setup.owner.runtimeId);
    await expect(completion).rejects.toThrow("CAPTURE_PERMISSION_REVOKED");
    await expect(promise).rejects.toThrow("CAPTURE_REVOKED");
  });

  test("cancelled uploads release their transport quota and refuse concurrent reads for one device", async () => {
    const setup = fixture();
    const promise = setup.request();
    const upload = setup.broker.receive("alice", setup.client.device.id, setup.client.transportToken, (_maxBytes, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("upload cancelled")), { once: true })));
    void upload.catch(() => {});
    await expect(setup.broker.receive("alice", setup.client.device.id, setup.client.transportToken, async () => ({}))).rejects.toThrow("CAPTURE_BUSY");
    setup.broker.revokeRuntime(setup.owner.runtimeId);
    await expect(upload).rejects.toThrow("upload cancelled");
    await expect(promise).rejects.toThrow("CAPTURE_REVOKED");
    setup.advance(5001);
    const next = setup.request();
    const command = setup.poll().find((item) => item.type === "capture")!;
    await setup.broker.receive("alice", setup.client.device.id, setup.client.transportToken, async () => setup.reply(command.requestId));
    expect((await next).kind).toBe("image");
  });

  test("disconnect and lease expiry cancel requests and cannot be revived with an old token", async () => {
    const setup = fixture();
    const promise = setup.request();
    setup.advance(DESKTOP_CAPTURE_LIMITS.deviceLeaseMs + 1);
    expect(setup.broker.listDevices("alice")).toEqual([]);
    await expect(promise).rejects.toThrow("DESKTOP_DISCONNECTED");
    expect(() => setup.poll()).toThrow("INVALID_DEVICE_LEASE");
  });

  test("handles expire independently of their metadata held by the extension", async () => {
    const setup = fixture();
    const promise = setup.request();
    await setup.complete(setup.poll()[0].requestId);
    const asset = await promise;
    setup.advance(DESKTOP_CAPTURE_LIMITS.assetTtlMs + 1);
    expect(() => setup.broker.release(setup.owner, asset.assetId)).toThrow("CAPTURE_ASSET_UNAVAILABLE");
  });

  test("bounds requests and consent prompts without starting unsupported recording", () => {
    const setup = fixture();
    expect(() => setup.request(() => true, { ...setup.input, kind: "video", mode: "replay", durationSeconds: 121 })).toThrow("INVALID_CAPTURE_REQUEST");
    expect(() => setup.request(() => true, { ...setup.input, deviceId: "unknown" })).toThrow("DESKTOP_UNAVAILABLE");
    setup.request();
    expect(() => setup.request()).toThrow("CAPTURE_BUSY");
    const device = setup.broker.register("alice", { name: "Still images", platform: "linux", capabilities: { image: true, video: false, replay: false } });
    expect(() => setup.request(() => true, { ...setup.input, deviceId: device.device.id, kind: "video", mode: "record", durationSeconds: 5 })).toThrow("CAPTURE_UNSUPPORTED");
  });

  test("native denial produces a stable error and cooldown prevents immediate repeated prompts", async () => {
    const setup = fixture();
    const promise = setup.request();
    const requestId = setup.poll()[0].requestId;
    await setup.complete(requestId, { requestId, outcome: "denied" });
    await expect(promise).rejects.toThrow("CAPTURE_DENIED");
    expect(() => setup.request()).toThrow("CAPTURE_RATE_LIMITED");
  });

  test("checks actual image format/dimensions instead of trusting producer metadata", async () => {
    for (const changes of [{ mimeType: "image/jpeg" }, { width: 100 }, { data: "AAAA" }, { data: "%%%" }]) {
      const setup = fixture();
      const promise = setup.request();
      const requestId = setup.poll()[0].requestId;
      const reply = setup.reply(requestId) as Extract<DesktopCaptureReply, { outcome: "approved" }>;
      await expect(setup.complete(requestId, { ...reply, media: { ...reply.media, ...changes } })).rejects.toThrow("INVALID_CAPTURE_MEDIA");
      await expect(promise).rejects.toThrow("INVALID_CAPTURE_MEDIA");
    }
  });

  test("accepts a bounded video container and rejects a mismatched/overlong clip", async () => {
    const setup = fixture();
    const input: DesktopCaptureRequest = { ...setup.input, kind: "video", mode: "replay", durationSeconds: 5 };
    const promise = setup.request(() => true, input);
    const requestId = setup.poll()[0].requestId;
    await setup.complete(requestId, { requestId, outcome: "approved", media: {
      mimeType: "video/mp4", data: Buffer.from([0, 0, 0, 20, ...Buffer.from("ftypisom")]).toString("base64"),
      width: 2, height: 2, durationSeconds: 5,
    } });
    expect((await promise).kind).toBe("video");
    setup.advance(5001);
    const overlong = setup.request(() => true, input);
    const nextId = setup.poll()[0].requestId;
    await expect(setup.complete(nextId, { requestId: nextId, outcome: "approved", media: {
      mimeType: "video/mp4", data: Buffer.from([0, 0, 0, 20, ...Buffer.from("ftypisom")]).toString("base64"),
      width: 2, height: 2, durationSeconds: 6,
    } })).rejects.toThrow("INVALID_CAPTURE_MEDIA");
    await expect(overlong).rejects.toThrow("INVALID_CAPTURE_MEDIA");
  });
});
