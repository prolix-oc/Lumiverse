import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DesktopCaptureBroker, type DesktopCaptureOwner } from "./desktop-capture-broker";
import { processCaptureMedia } from "./desktop-capture-processing";
import { resolveFfmpegBinary } from "../services/ffmpeg-binary.service";
import type { DesktopCaptureDestination, DesktopCaptureOptimizeRequest } from "./desktop-capture-contract";
import type { LlmMessage } from "../llm/types";

const brokers: DesktopCaptureBroker[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.dispose(); });
const owner: DesktopCaptureOwner = { runtimeId: "runtime", extensionId: "extension", identifier: "test", name: "Test", userId: "alice" };
const destination: DesktopCaptureDestination = { connectionId: "connection", revision: "revision", provider: "google", model: "gemini", endpointOrigin: "provider-default" };

async function fixture(processMedia?: typeof processCaptureMedia) {
  let now = 1000;
  const broker = new DesktopCaptureBroker({ now: () => now, processMedia });
  brokers.push(broker);
  const native = broker.register(owner.userId, { name: "Native", platform: "windows", capabilities: { image: true, video: true, replay: false } });
  const waiting = broker.request(owner, { deviceId: native.device.id, connectionId: destination.connectionId, kind: "image", purpose: "Test screenshot" }, destination, () => true);
  const command = broker.poll(owner.userId, native.device.id, native.transportToken)[0]!;
  const data = await sharp({ create: { width: 600, height: 1000, channels: 3, background: "#804020" } }).png().toBuffer();
  await broker.complete(owner.userId, native.device.id, native.transportToken, { requestId: command.requestId, outcome: "approved",
    media: { mimeType: "image/png", data: data.toString("base64"), width: 600, height: 1000 } });
  const ref = await waiting;
  const input: DesktopCaptureOptimizeRequest = { assetId: ref.assetId, connectionId: destination.connectionId, kind: "image", maxEdge: 500, format: "jpeg", quality: 80 };
  return { broker, ref, input, advance: (ms: number) => { now += ms; } };
}

test("optimization preserves a scoped single-use handle and expiry while resizing portrait captures", async () => {
  const setup = await fixture();
  const ref = await setup.broker.optimize(owner, setup.input, destination, () => true);
  expect(ref).toMatchObject({ assetId: setup.ref.assetId, connectionId: setup.ref.connectionId, expiresAt: setup.ref.expiresAt,
    kind: "image", mimeType: "image/jpeg", width: 300, height: 500 });
  expect(ref.byteSize).toBeGreaterThan(0);
  const messages = setup.broker.resolveMessages(owner, [{ role: "user", content: [{ type: "desktop_capture", asset_id: ref.assetId }] }] as unknown as LlmMessage[], destination, () => true);
  const part = (messages[0]!.content as any[])[0];
  expect(part.mime_type).toBe("image/jpeg");
  expect(await sharp(Buffer.from(part.data, "base64")).metadata()).toMatchObject({ format: "jpeg", width: 300, height: 500 });
  expect(() => setup.broker.release(owner, ref.assetId)).toThrow("CAPTURE_ASSET_UNAVAILABLE");
});

test("optimization enforces account/runtime/extension, kind, destination, grants and option bounds", async () => {
  const setup = await fixture();
  for (const change of [{ userId: "bob" }, { runtimeId: "other" }, { extensionId: "other" }]) {
    await expect(setup.broker.optimize({ ...owner, ...change }, setup.input, destination, () => true)).rejects.toThrow("CAPTURE_ASSET_UNAVAILABLE");
  }
  await expect(setup.broker.optimize(owner, setup.input, { ...destination, revision: "new" }, () => true)).rejects.toThrow("CAPTURE_DESTINATION_CHANGED");
  await expect(setup.broker.optimize(owner, setup.input, destination, () => false)).rejects.toThrow("CAPTURE_PERMISSION_REVOKED");
  await expect(setup.broker.optimize(owner, { ...setup.input, kind: "video", fps: 15, bitrateKbps: 2500 }, destination, () => true)).rejects.toThrow("INVALID_CAPTURE_OPTIMIZATION");
  for (const change of [{ maxEdge: 0 }, { maxEdge: 4000 }, { maxEdge: NaN }, { quality: 101 }, { quality: "80" }, { format: "svg" }]) {
    await expect(setup.broker.optimize(owner, { ...setup.input, ...change } as any, destination, () => true)).rejects.toThrow("INVALID_CAPTURE_OPTIMIZATION");
  }
  expect(await setup.broker.optimize(owner, { ...setup.input, maxEdge: 3840, format: "png" }, destination, () => true)).toMatchObject({ width: 600, height: 1000 });
});

test("revocation or release during processing aborts the conversion and cannot revive a handle", async () => {
  for (const revoke of [false, true]) {
    let signal: AbortSignal | undefined;
    let complete!: () => void;
    const ready = Promise.withResolvers<void>();
    const gate = new Promise<void>(resolve => { complete = resolve; });
    const setup = await fixture(async (data, ref, _input, incoming) => {
      signal = incoming; ready.resolve(); await gate;
      return { data: Buffer.from(data), mimeType: ref.mimeType, width: ref.width, height: ref.height };
    });
    const waiting = setup.broker.optimize(owner, setup.input, destination, () => true);
    await ready.promise;
    await expect(setup.broker.optimize(owner, setup.input, destination, () => true)).rejects.toThrow("CAPTURE_BUSY");
    if (revoke) setup.broker.revokeRuntime(owner.runtimeId); else setup.broker.release(owner, setup.ref.assetId);
    expect(signal?.aborted).toBe(true);
    complete();
    await expect(waiting).rejects.toThrow("CAPTURE_OPTIMIZATION_FAILED");
    expect(() => setup.broker.release(owner, setup.ref.assetId)).toThrow("CAPTURE_ASSET_UNAVAILABLE");
  }
});

test("failed conversion keeps the original available; authorization and expiry are rechecked after processing", async () => {
  const failed = await fixture(async () => { throw new Error("private ffmpeg paths and diagnostics"); });
  await expect(failed.broker.optimize(owner, failed.input, destination, () => true)).rejects.toThrow("CAPTURE_OPTIMIZATION_FAILED");
  failed.broker.release(owner, failed.ref.assetId);
  let permitted = true;
  const setup = await fixture(async (data, ref) => {
    permitted = false;
    return { data: Buffer.from(data), mimeType: ref.mimeType, width: ref.width, height: ref.height };
  });
  await expect(setup.broker.optimize(owner, setup.input, destination, () => permitted)).rejects.toThrow("CAPTURE_PERMISSION_REVOKED");
  const expired = await fixture(async (data, ref) => {
    expired.advance(120001);
    return { data: Buffer.from(data), mimeType: ref.mimeType, width: ref.width, height: ref.height };
  });
  await expect(expired.broker.optimize(owner, expired.input, destination, () => true)).rejects.toThrow("CAPTURE_ASSET_UNAVAILABLE");
});

const ffmpeg = await resolveFfmpegBinary();
test.skipIf(!ffmpeg)("real video transcode preserves the full clip and produces a smaller silent H.264 portrait MP4", async () => {
  const directory = await mkdtemp(join(tmpdir(), "capture-transcode-test-"));
  try {
    const path = join(directory, "input.mp4");
    const generated = Bun.spawn([ffmpeg!, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x480:rate=30", "-t", "1", "-c:v", "libx264", "-threads", "2", "-b:v", "8M", "-y", path], { stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(generated.stderr).text();
    expect(await generated.exited, stderr).toBe(0);
    const data = Buffer.from(await Bun.file(path).arrayBuffer());
    const ref = { assetId: "private", kind: "video" as const, mimeType: "video/mp4", width: 320, height: 480, durationSeconds: 1, connectionId: "connection", expiresAt: Date.now() + 120000 };
    const result = await processCaptureMedia(data, ref, { assetId: ref.assetId, connectionId: ref.connectionId, kind: "video", maxEdge: 256, fps: 10, bitrateKbps: 500 }, new AbortController().signal, 128 * 1024 * 1024);
    expect(result).toMatchObject({ mimeType: "video/mp4", width: 170, height: 256, durationSeconds: 1 });
    expect(result.data.length).toBeLessThan(data.length);
    const higherBitrate = await processCaptureMedia(data, ref, { assetId: ref.assetId, connectionId: ref.connectionId, kind: "video", maxEdge: 256, fps: 10, bitrateKbps: 2000 }, new AbortController().signal, 128 * 1024 * 1024);
    expect(higherBitrate.data.length).toBeGreaterThan(result.data.length);
    const probePath = join(directory, "output.mp4"); await Bun.write(probePath, result.data);
    const probe = Bun.spawn([ffmpeg!, "-hide_banner", "-i", probePath], { stdout: "ignore", stderr: "pipe" });
    const info = await new Response(probe.stderr).text(); await probe.exited;
    expect(info).toContain("Video: h264"); expect(info).toContain("10 fps"); expect(info).not.toContain("Audio:");
    await expect(processCaptureMedia(data, ref, { assetId: ref.assetId, connectionId: ref.connectionId, kind: "video", maxEdge: 256, fps: 10, bitrateKbps: 500 }, AbortSignal.abort(), 128 * 1024 * 1024)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15000);
