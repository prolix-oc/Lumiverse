import { createHash, timingSafeEqual } from "node:crypto";
import sharp from "sharp";
import type {
  CapturedMediaRef,
  DesktopCaptureCommand,
  DesktopCaptureDestination,
  DesktopCaptureDevice,
  DesktopCaptureDisplay,
  DesktopCaptureReply,
  DesktopCaptureRequest,
  DesktopCaptureApprovalQuery,
  DesktopCaptureApprovalStatus,
  DesktopCaptureOptimizeRequest,
} from "./desktop-capture-contract";
import type { LlmMessage, LlmMessagePart } from "../llm/types";
import { processCaptureMedia, validCaptureOptimization } from "./desktop-capture-processing";

export const DESKTOP_CAPTURE_LIMITS = Object.freeze({
  imageBytes: 8 * 1024 * 1024,
  videoBytes: 128 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  maxPixels: 16_777_216,
  maxDurationSeconds: 120,
  requestTimeoutMs: 300_000,
  assetTtlMs: 120_000,
  deviceLeaseMs: 45_000,
  cooldownMs: 5_000,
});

export class DesktopCaptureError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
  }
}

export interface DesktopCaptureOwner {
  runtimeId: string;
  approvalRevision?: string;
  extensionId: string;
  identifier: string;
  name: string;
  userId: string;
}

type Device = {
  userId: string;
  token: string;
  info: DesktopCaptureDevice;
  queue: DesktopCaptureCommand[];
  timer: ReturnType<typeof setTimeout>;
};

type PendingCapture = {
  owner: DesktopCaptureOwner;
  deviceId: string;
  input: DesktopCaptureRequest;
  destination: DesktopCaptureDestination;
  authorized: () => boolean;
  resolve: (asset: CapturedMediaRef) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  completing: boolean;
  finishRequested: boolean;
  expiresAt: number;
};

type Asset = {
  owner: DesktopCaptureOwner;
  deviceId: string;
  destination: DesktopCaptureDestination;
  ref: CapturedMediaRef;
  data: Buffer;
  timer: ReturnType<typeof setTimeout>;
};

type Inspection = {
  owner: DesktopCaptureOwner; deviceId: string; kind: DesktopCaptureApprovalQuery["kind"];
  displayId?: string;
  authorized: () => boolean; timer: ReturnType<typeof setTimeout>;
  resolve: (status: DesktopCaptureApprovalStatus) => void; reject: (error: Error) => void;
};

export class DesktopCaptureBroker {
  private readonly devices = new Map<string, Device>();
  private readonly pending = new Map<string, PendingCapture>();
  private readonly inspections = new Map<string, Inspection>();
  private readonly assets = new Map<string, Asset>();
  private readonly lastRequest = new Map<string, number>();
  private retainedBytes = 0;
  private incomingBytes = 0;
  private incomingTransportBytes = 0;
  private readonly receivingDevices = new Map<string, AbortController>();
  private readonly processing = new Map<string, AbortController>();

  constructor(private readonly options: { now?: () => number; requestTimeoutMs?: number;
    processMedia?: typeof processCaptureMedia } = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  updateDisplays(userId: string, deviceId: string, token: string, input: unknown): void {
    const device = this.authenticate(userId, deviceId, token);
    if (!Array.isArray(input) || input.length > 16 || input.some(display =>
      !display || typeof display !== "object" || typeof display.id !== "string" || !/^[a-f0-9]{64}$/.test(display.id)
      || typeof display.name !== "string" || !display.name.trim() || display.name.length > 80
      || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(display.name)
      || !Number.isInteger(display.width) || display.width < 1 || display.width > 32768
      || !Number.isInteger(display.height) || display.height < 1 || display.height > 32768
      || typeof display.primary !== "boolean")
      || new Set(input.map(display => display.id)).size !== input.length) throw new DesktopCaptureError("INVALID_DISPLAYS");
    device.info.displays = input.map(({ id, name, width, height, primary }) => ({ id, name, width, height, primary } satisfies DesktopCaptureDisplay));
    for (const [id, pending] of this.pending) {
      if (pending.deviceId === deviceId && pending.input.displayId && !device.info.displays.some(display => display.id === pending.input.displayId)) this.cancel(id, "CAPTURE_DISPLAY_UNAVAILABLE");
    }
    for (const [id, query] of this.inspections) {
      if (query.deviceId === deviceId && query.displayId && !device.info.displays.some(display => display.id === query.displayId)) this.cancelInspection(id, "CAPTURE_DISPLAY_UNAVAILABLE");
    }
  }

  private requireDisplay(device: Device, displayId: unknown): void {
    if (displayId === undefined) return;
    if (typeof displayId !== "string" || !/^[a-f0-9]{64}$/.test(displayId)) throw new DesktopCaptureError("INVALID_CAPTURE_REQUEST");
    if (!device.info.displays?.some(display => display.id === displayId)) throw new DesktopCaptureError("CAPTURE_DISPLAY_UNAVAILABLE", 404);
  }

  register(userId: string, input: unknown): { device: DesktopCaptureDevice; transportToken: string } {
    if (!input || typeof input !== "object") throw new DesktopCaptureError("INVALID_DEVICE");
    const value = input as Record<string, any>;
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80
      || /[\x00-\x1f\x7f]/.test(value.name)
      || !["linux", "macos", "windows"].includes(value.platform)
      || !value.capabilities || typeof value.capabilities !== "object"
      || ["image", "video", "replay"].some((key) => typeof value.capabilities[key] !== "boolean")
      || (value.capabilities.replay && !value.capabilities.video)) {
      throw new DesktopCaptureError("INVALID_DEVICE");
    }
    if (value.deviceKey !== undefined && (typeof value.deviceKey !== "string" || !/^[a-f0-9]{64}$/.test(value.deviceKey))) throw new DesktopCaptureError("INVALID_DEVICE");
    if (value.approvalStatus !== undefined && typeof value.approvalStatus !== "boolean") throw new DesktopCaptureError("INVALID_DEVICE");
    if (value.recordingControl !== undefined && typeof value.recordingControl !== "boolean") throw new DesktopCaptureError("INVALID_DEVICE");
    const hash = value.deviceKey ? createHash("sha256").update(JSON.stringify([userId, value.deviceKey])).digest("hex") : null;
    const id = hash ? `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}` : crypto.randomUUID();
    // Replacement rotates the secret lease and cancels old work; stable identity cannot revive it.
    if (this.devices.get(id)?.userId === userId) this.disconnect(id);
    if (this.devices.size >= 32 || [...this.devices.values()].filter((device) => device.userId === userId).length >= 4) {
      throw new DesktopCaptureError("DEVICE_LIMIT", 429);
    }
    const token = crypto.randomUUID() + crypto.randomUUID();
    const info: DesktopCaptureDevice = {
      id, name: value.name.trim(), platform: value.platform,
      ...(hash ? { stableIdentity: true } : {}),
      ...(value.approvalStatus ? { approvalStatusSupported: true } : {}),
      ...(value.recordingControl ? { recordingControlSupported: true } : {}),
      capabilities: { image: value.capabilities.image, video: value.capabilities.video, replay: value.capabilities.replay },
      expiresAt: this.now() + DESKTOP_CAPTURE_LIMITS.deviceLeaseMs,
    };
    const timer = setTimeout(() => this.disconnect(id), DESKTOP_CAPTURE_LIMITS.deviceLeaseMs);
    timer.unref();
    this.devices.set(id, { userId, token, info, queue: [], timer });
    return { device: structuredClone(info), transportToken: token };
  }

  private authenticate(userId: string, deviceId: string, token: string): Device {
    const device = this.devices.get(deviceId);
    if (device && device.info.expiresAt <= this.now()) this.disconnect(deviceId);
    const supplied = Buffer.from(typeof token === "string" ? token : "");
    const expected = Buffer.from(device?.token ?? "");
    if (!device || !this.devices.has(deviceId) || device.userId !== userId
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new DesktopCaptureError("INVALID_DEVICE_LEASE", 401);
    }
    return device;
  }

  poll(userId: string, deviceId: string, token: string): DesktopCaptureCommand[] {
    const device = this.authenticate(userId, deviceId, token);
    this.setLeaseExpiry(deviceId, device, this.now() + DESKTOP_CAPTURE_LIMITS.deviceLeaseMs);
    return device.queue.splice(0);
  }

  private setLeaseExpiry(deviceId: string, device: Device, expiresAt: number): void {
    clearTimeout(device.timer);
    device.info.expiresAt = expiresAt;
    device.timer = setTimeout(() => {
      if (this.devices.get(deviceId) === device) this.disconnect(deviceId);
    }, Math.max(0, expiresAt - this.now()));
    device.timer.unref();
  }

  unregister(userId: string, deviceId: string, token: string): void {
    this.authenticate(userId, deviceId, token);
    this.disconnect(deviceId);
  }

  listDevices(userId: string): DesktopCaptureDevice[] {
    for (const [id, device] of this.devices) if (device.info.expiresAt <= this.now()) this.disconnect(id);
    return [...this.devices.values()].filter((device) => device.userId === userId)
      .map((device) => structuredClone(device.info));
  }

  inspect(owner: DesktopCaptureOwner, input: DesktopCaptureApprovalQuery, destination: DesktopCaptureDestination, authorized: () => boolean): Promise<DesktopCaptureApprovalStatus> {
    if (!input || !["image", "video"].includes(input.kind) || input.connectionId !== destination.connectionId) throw new DesktopCaptureError("INVALID_CAPTURE_REQUEST");
    if (!authorized()) throw new DesktopCaptureError("CAPTURE_PERMISSION_REVOKED", 403);
    const device = this.devices.get(input.deviceId);
    if (!device || device.userId !== owner.userId || device.info.expiresAt <= this.now()) throw new DesktopCaptureError("DESKTOP_UNAVAILABLE", 404);
    this.requireDisplay(device, input.displayId);
    if (!device.info.approvalStatusSupported) return Promise.resolve({ deviceId: input.deviceId, kind: input.kind, approval: "unknown", source: "unknown", checkedAt: this.now() });
    if (this.inspections.size >= 32 || device.queue.length >= 16 || [...this.inspections.values()].some(query => query.owner.runtimeId === owner.runtimeId && query.owner.userId === owner.userId)) throw new DesktopCaptureError("CAPTURE_BUSY", 429);
    const requestId = crypto.randomUUID();
    const command: DesktopCaptureCommand = { type: "approval_status", requestId,
      extension: { id: owner.extensionId, identifier: owner.identifier, name: owner.name, ...(owner.approvalRevision ? { approvalRevision: owner.approvalRevision } : {}) },
      kind: input.kind, ...(input.displayId ? { displayId: input.displayId } : {}), destination: { ...destination }, expiresAt: this.now() + 10_000 };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancelInspection(requestId, "CAPTURE_TIMEOUT"), 10_000); timer.unref();
      this.inspections.set(requestId, { owner: { ...owner }, deviceId: input.deviceId, displayId: input.displayId, kind: input.kind, authorized, timer, resolve, reject });
      device.queue.push(command);
    });
  }

  completeInspection(userId: string, deviceId: string, token: string, input: unknown): void {
    this.authenticate(userId, deviceId, token);
    const value = input as Record<string, unknown> | null;
    if (!value || typeof value.requestId !== "string" || !["required", "remembered", "paused", "unavailable"].includes(value.approval as string)
      || !["ready", "missing", "permission_required", "unknown"].includes(value.source as string)) throw new DesktopCaptureError("INVALID_CAPTURE_STATUS");
    const pending = this.inspections.get(value.requestId);
    if (!pending || pending.deviceId !== deviceId || pending.owner.userId !== userId) throw new DesktopCaptureError("CAPTURE_STATUS_EXPIRED", 410);
    if (!pending.authorized()) { this.cancelInspection(value.requestId, "CAPTURE_REVOKED"); return; }
    clearTimeout(pending.timer); this.inspections.delete(value.requestId);
    pending.resolve({ deviceId, ...(pending.displayId ? { displayId: pending.displayId } : {}), kind: pending.kind, approval: value.approval as DesktopCaptureApprovalStatus["approval"], source: value.source as DesktopCaptureApprovalStatus["source"], checkedAt: this.now() });
  }

  private cancelInspection(requestId: string, code: string): void {
    const pending = this.inspections.get(requestId); if (!pending) return;
    clearTimeout(pending.timer); this.inspections.delete(requestId);
    const device = this.devices.get(pending.deviceId);
    if (device) device.queue = device.queue.filter(command => command.requestId !== requestId);
    pending.reject(new DesktopCaptureError(code));
  }

  request(owner: DesktopCaptureOwner, input: DesktopCaptureRequest, destination: DesktopCaptureDestination,
    authorized: () => boolean): Promise<CapturedMediaRef> {
    if (!input || typeof input !== "object" || typeof input.purpose !== "string"
      || !input.purpose.trim() || input.purpose.length > 240 || /[\x00-\x1f\x7f]/.test(input.purpose)
      || !["image", "video"].includes(input.kind)
      || (input.requestKey !== undefined && (typeof input.requestKey !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestKey)))
      || input.connectionId !== destination.connectionId
      || (input.kind === "image" && ("mode" in input || "durationSeconds" in input))
      || (input.kind === "video" && (!["record", "replay"].includes(input.mode)
        || !Number.isInteger(input.durationSeconds) || input.durationSeconds < 1
        || input.durationSeconds > DESKTOP_CAPTURE_LIMITS.maxDurationSeconds))) {
      throw new DesktopCaptureError("INVALID_CAPTURE_REQUEST");
    }
    if (!authorized()) throw new DesktopCaptureError("CAPTURE_PERMISSION_REVOKED", 403);
    const device = this.devices.get(input.deviceId);
    if (device && device.info.expiresAt <= this.now()) this.disconnect(input.deviceId);
    if (!device || !this.devices.has(input.deviceId) || device.userId !== owner.userId) {
      throw new DesktopCaptureError("DESKTOP_UNAVAILABLE", 404);
    }
    this.requireDisplay(device, input.displayId);
    if (!device.info.capabilities[input.kind] || (input.kind === "video" && input.mode === "replay" && !device.info.capabilities.replay)) {
      throw new DesktopCaptureError("CAPTURE_UNSUPPORTED", 409);
    }
    const captures = [...this.pending.values()];
    if (captures.length >= 16 || captures.some((capture) => capture.deviceId === input.deviceId)
      || captures.some((capture) => capture.owner.runtimeId === owner.runtimeId && capture.owner.userId === owner.userId)
      || [...this.assets.values()].filter((asset) => asset.owner.runtimeId === owner.runtimeId).length >= 4) {
      throw new DesktopCaptureError("CAPTURE_BUSY", 429);
    }
    const cooldownKey = `${owner.userId}:${owner.extensionId}`;
    if (this.now() - (this.lastRequest.get(cooldownKey) ?? -Infinity) < DESKTOP_CAPTURE_LIMITS.cooldownMs) {
      throw new DesktopCaptureError("CAPTURE_RATE_LIMITED", 429);
    }
    if (this.lastRequest.size > 1024) {
      for (const [key, time] of this.lastRequest) if (this.now() - time >= DESKTOP_CAPTURE_LIMITS.cooldownMs) this.lastRequest.delete(key);
    }
    this.lastRequest.set(cooldownKey, this.now());
    const requestId = crypto.randomUUID();
    const timeoutMs = this.options.requestTimeoutMs ?? DESKTOP_CAPTURE_LIMITS.requestTimeoutMs;
    const command: DesktopCaptureCommand = {
      type: "capture", requestId, extension: { id: owner.extensionId, identifier: owner.identifier, name: owner.name, ...(owner.approvalRevision ? { approvalRevision: owner.approvalRevision } : {}) },
      purpose: input.purpose.trim(), kind: input.kind, destination: { ...destination },
      ...(input.displayId ? { displayId: input.displayId } : {}),
      ...(input.kind === "video" ? { mode: input.mode, durationSeconds: input.durationSeconds } : {}),
      maxBytes: input.kind === "image" ? DESKTOP_CAPTURE_LIMITS.imageBytes : DESKTOP_CAPTURE_LIMITS.videoBytes,
      maxPixels: DESKTOP_CAPTURE_LIMITS.maxPixels, expiresAt: this.now() + timeoutMs,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(requestId, "CAPTURE_TIMEOUT"), timeoutMs);
      timer.unref();
      this.pending.set(requestId, { owner: { ...owner }, deviceId: input.deviceId, input: { ...input },
        destination: { ...destination }, authorized, resolve, reject, timer, completing: false, finishRequested: false, expiresAt: command.expiresAt });
      device.queue.push(command);
    });
  }

  finish(owner: DesktopCaptureOwner, requestKey: string): boolean {
    if (typeof requestKey !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestKey)) throw new DesktopCaptureError("INVALID_CAPTURE_REQUEST");
    const entry = [...this.pending.entries()].find(([, pending]) => pending.owner.runtimeId === owner.runtimeId
      && pending.owner.extensionId === owner.extensionId && pending.owner.userId === owner.userId && pending.input.requestKey === requestKey);
    if (!entry) return false;
    const [requestId, pending] = entry;
    if (pending.input.kind !== "video" || pending.input.mode !== "record") throw new DesktopCaptureError("CAPTURE_UNSUPPORTED", 409);
    if (!pending.authorized()) { this.cancel(requestId, "CAPTURE_REVOKED"); throw new DesktopCaptureError("CAPTURE_REVOKED", 403); }
    const device = this.devices.get(pending.deviceId);
    if (!device || device.info.expiresAt <= this.now()) throw new DesktopCaptureError("DESKTOP_UNAVAILABLE", 404);
    if (!device.info.recordingControlSupported) throw new DesktopCaptureError("CAPTURE_FINISH_UNSUPPORTED", 409);
    if (pending.finishRequested || pending.completing) return true;
    if (device.queue.length >= 16) throw new DesktopCaptureError("CAPTURE_BUSY", 429);
    pending.finishRequested = true;
    device.queue.push({ type: "finish", requestId });
    return true;
  }

  async receive(userId: string, deviceId: string, token: string, read: (maxBytes: number, signal: AbortSignal) => Promise<unknown>): Promise<void> {
    const device = this.authenticate(userId, deviceId, token);
    const pending = [...this.pending.values()].find((capture) => capture.deviceId === deviceId && capture.owner.userId === userId);
    if (!pending) throw new DesktopCaptureError("UNKNOWN_CAPTURE_REQUEST", 404);
    if (this.receivingDevices.has(deviceId) || pending.completing) throw new DesktopCaptureError("CAPTURE_BUSY", 429);
    const maxBytes = Math.ceil((pending.input.kind === "image" ? DESKTOP_CAPTURE_LIMITS.imageBytes : DESKTOP_CAPTURE_LIMITS.videoBytes) / 3) * 4 + 4096;
    const transportLimit = Math.ceil(DESKTOP_CAPTURE_LIMITS.totalBytes / 3) * 4 + 8192;
    if (this.incomingTransportBytes + maxBytes > transportLimit) throw new DesktopCaptureError("CAPTURE_MEMORY_LIMIT", 429);
    const controller = new AbortController();
    this.receivingDevices.set(deviceId, controller);
    this.incomingTransportBytes += maxBytes;
    // Native uploads pause polling. Keep this authenticated upload's lease live
    // for its bounded transfer window; explicit revocation still removes it.
    this.setLeaseExpiry(deviceId, device, Math.max(device.info.expiresAt, Math.min(pending.expiresAt, this.now() + 120_000)));
    try { await this.complete(userId, deviceId, token, await read(maxBytes, controller.signal)); }
    finally {
      if (this.receivingDevices.get(deviceId) === controller) this.receivingDevices.delete(deviceId);
      this.incomingTransportBytes -= maxBytes;
      if (this.devices.get(deviceId) === device) this.setLeaseExpiry(deviceId, device, Math.min(device.info.expiresAt, this.now() + DESKTOP_CAPTURE_LIMITS.deviceLeaseMs));
    }
  }

  async complete(userId: string, deviceId: string, token: string, value: unknown): Promise<void> {
    this.authenticate(userId, deviceId, token);
    const reply = value as DesktopCaptureReply;
    const pending = value && typeof value === "object" && typeof reply.requestId === "string"
      ? this.pending.get(reply.requestId) : undefined;
    if (!pending || pending.deviceId !== deviceId || pending.owner.userId !== userId || pending.completing) {
      throw new DesktopCaptureError("UNKNOWN_CAPTURE_REQUEST", 404);
    }
    if (!["approved", "denied", "cancelled", "unsupported", "failed"].includes(reply.outcome)) {
      throw new DesktopCaptureError("INVALID_CAPTURE_REPLY");
    }
    if (reply.outcome !== "approved") {
      this.cancel(reply.requestId, `CAPTURE_${reply.outcome.toUpperCase()}`);
      return;
    }
    pending.completing = true;
    let reservedBytes = 0;
    try {
      if (!pending.authorized()) throw new DesktopCaptureError("CAPTURE_PERMISSION_REVOKED", 403);
      const media = reply.media;
      const maxBytes = pending.input.kind === "image" ? DESKTOP_CAPTURE_LIMITS.imageBytes : DESKTOP_CAPTURE_LIMITS.videoBytes;
      if (!media || typeof media.data !== "string" || media.data.length > Math.ceil(maxBytes / 3) * 4
        || media.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(media.data)) {
        throw new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
      }
      reservedBytes = media.data.length / 4 * 3 - (media.data.endsWith("==") ? 2 : media.data.endsWith("=") ? 1 : 0);
      if (this.retainedBytes + this.incomingBytes + reservedBytes > DESKTOP_CAPTURE_LIMITS.totalBytes) {
        reservedBytes = 0;
        throw new DesktopCaptureError("CAPTURE_MEMORY_LIMIT", 429);
      }
      this.incomingBytes += reservedBytes;
      const data = Buffer.from(media.data, "base64");
      if (data.toString("base64") !== media.data || !data.length || data.byteLength > maxBytes || !Number.isInteger(media.width) || !Number.isInteger(media.height)
        || media.width < 1 || media.height < 1 || media.width * media.height > DESKTOP_CAPTURE_LIMITS.maxPixels) {
        throw new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
      }
      if (pending.input.kind === "image") {
        const formats: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };
        if (!Object.hasOwn(formats, media.mimeType)) throw new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
        const metadata = await sharp(data, { limitInputPixels: DESKTOP_CAPTURE_LIMITS.maxPixels }).metadata();
        if (metadata.format !== formats[media.mimeType] || metadata.width !== media.width || metadata.height !== media.height
          || (metadata.pages ?? 1) !== 1) throw new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
      } else {
        const validContainer = (media.mimeType === "video/mp4" && data.length >= 12 && data.toString("ascii", 4, 8) === "ftyp")
          || (media.mimeType === "video/webm" && data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
        if (!validContainer || !Number.isFinite(media.durationSeconds) || media.durationSeconds! <= 0
          || media.durationSeconds! > pending.input.durationSeconds) throw new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
      }
      if (this.pending.get(reply.requestId) !== pending || !pending.authorized()) {
        throw new DesktopCaptureError("CAPTURE_PERMISSION_REVOKED", 403);
      }
      this.authenticate(userId, deviceId, token);
      if (this.retainedBytes + data.byteLength > DESKTOP_CAPTURE_LIMITS.totalBytes) throw new DesktopCaptureError("CAPTURE_MEMORY_LIMIT", 429);
      const assetId = crypto.randomUUID();
      const ref: CapturedMediaRef = {
        assetId, kind: pending.input.kind, mimeType: media.mimeType, width: media.width, height: media.height,
        ...(pending.input.kind === "video" ? { durationSeconds: media.durationSeconds } : {}),
        connectionId: pending.destination.connectionId, expiresAt: this.now() + DESKTOP_CAPTURE_LIMITS.assetTtlMs,
        byteSize: data.byteLength,
      };
      const timer = setTimeout(() => this.deleteAsset(assetId), DESKTOP_CAPTURE_LIMITS.assetTtlMs);
      timer.unref();
      this.assets.set(assetId, { owner: pending.owner, deviceId, destination: pending.destination, ref, data, timer });
      this.retainedBytes += data.byteLength;
      clearTimeout(pending.timer);
      this.pending.delete(reply.requestId);
      pending.resolve({ ...ref });
    } catch (error) {
      this.cancel(reply.requestId, error instanceof DesktopCaptureError ? error.code : "INVALID_CAPTURE_MEDIA");
      throw error instanceof DesktopCaptureError ? error : new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
    } finally {
      this.incomingBytes -= reservedBytes;
    }
  }

  release(owner: DesktopCaptureOwner, assetId: string): void {
    const asset = this.requireAsset(owner, assetId);
    this.deleteAsset(asset.ref.assetId);
  }

  async optimize(owner: DesktopCaptureOwner, input: DesktopCaptureOptimizeRequest,
    destination: DesktopCaptureDestination, authorized: () => boolean): Promise<CapturedMediaRef> {
    if (!validCaptureOptimization(input)) throw new DesktopCaptureError("INVALID_CAPTURE_OPTIMIZATION");
    const asset = this.requireAsset(owner, input.assetId);
    const check = () => {
      if (this.requireAsset(owner, input.assetId) !== asset) throw new DesktopCaptureError("CAPTURE_ASSET_UNAVAILABLE", 404);
      if (!authorized() || asset.owner.approvalRevision !== owner.approvalRevision) throw new DesktopCaptureError("CAPTURE_PERMISSION_REVOKED", 403);
      if (asset.ref.kind !== input.kind) throw new DesktopCaptureError("INVALID_CAPTURE_OPTIMIZATION");
      if (asset.destination.connectionId !== destination.connectionId || input.connectionId !== destination.connectionId
        || asset.destination.revision !== destination.revision) throw new DesktopCaptureError("CAPTURE_DESTINATION_CHANGED", 403);
    };
    check();
    if (this.processing.has(input.assetId) || this.processing.size >= 2) throw new DesktopCaptureError("CAPTURE_BUSY", 429);
    const reserved = input.kind === "video" ? DESKTOP_CAPTURE_LIMITS.videoBytes : DESKTOP_CAPTURE_LIMITS.imageBytes;
    if (this.retainedBytes + this.incomingBytes + reserved > DESKTOP_CAPTURE_LIMITS.totalBytes) throw new DesktopCaptureError("CAPTURE_MEMORY_LIMIT", 429);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(90_000, asset.ref.expiresAt - this.now()));
    timer.unref();
    this.processing.set(input.assetId, controller);
    this.incomingBytes += reserved;
    let output: Buffer | undefined;
    try {
      const processed = await (this.options.processMedia ?? processCaptureMedia)(asset.data, { ...asset.ref }, input, controller.signal, reserved);
      output = processed.data;
      controller.signal.throwIfAborted();
      check();
      if (!output.length || output.length > reserved) throw new DesktopCaptureError("CAPTURE_MEMORY_LIMIT", 429);
      this.retainedBytes += output.length - asset.data.length;
      asset.data.fill(0);
      asset.data = output;
      output = undefined;
      asset.ref = { ...asset.ref, mimeType: processed.mimeType, width: processed.width, height: processed.height,
        ...(processed.durationSeconds === undefined ? {} : { durationSeconds: processed.durationSeconds }), byteSize: asset.data.length };
      return { ...asset.ref };
    } catch (error) {
      if (error instanceof DesktopCaptureError) throw error;
      throw new DesktopCaptureError("CAPTURE_OPTIMIZATION_FAILED");
    } finally {
      output?.fill(0);
      clearTimeout(timer);
      this.processing.delete(input.assetId);
      this.incomingBytes -= reserved;
    }
  }

  private requireAsset(owner: DesktopCaptureOwner, assetId: string): Asset {
    const asset = this.assets.get(assetId);
    if (asset && asset.ref.expiresAt <= this.now()) this.deleteAsset(assetId);
    if (!asset || !this.assets.has(assetId) || asset.owner.runtimeId !== owner.runtimeId
      || asset.owner.extensionId !== owner.extensionId || asset.owner.userId !== owner.userId) {
      throw new DesktopCaptureError("CAPTURE_ASSET_UNAVAILABLE", 404);
    }
    return asset;
  }

  resolveMessages(owner: DesktopCaptureOwner, messages: LlmMessage[], destination: DesktopCaptureDestination,
    authorized: (kind: "image" | "video") => boolean): LlmMessage[] {
    const selected = new Map<string, Asset>();
    const resolved = messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      return { ...message, content: message.content.map((part) => {
        if ((part as { type: string }).type !== "desktop_capture") return part;
        const assetId = (part as unknown as { asset_id: string }).asset_id;
        const asset = this.requireAsset(owner, assetId);
        if (this.processing.has(assetId)) throw new DesktopCaptureError("CAPTURE_BUSY", 429);
        if (!authorized(asset.ref.kind)) throw new DesktopCaptureError("CAPTURE_PERMISSION_REVOKED", 403);
        if (asset.destination.connectionId !== destination.connectionId || asset.destination.revision !== destination.revision) {
          throw new DesktopCaptureError("CAPTURE_DESTINATION_CHANGED", 403);
        }
        selected.set(assetId, asset);
        return { type: asset.ref.kind, mime_type: asset.ref.mimeType, data: asset.data.toString("base64") } as LlmMessagePart;
      }) };
    });
    for (const id of selected.keys()) this.deleteAsset(id);
    return resolved;
  }

  revokeRuntime(runtimeId: string): void {
    for (const [id, query] of this.inspections) if (query.owner.runtimeId === runtimeId) this.cancelInspection(id, "CAPTURE_REVOKED");
    for (const [id, pending] of this.pending) if (pending.owner.runtimeId === runtimeId) this.cancel(id, "CAPTURE_REVOKED");
    for (const [id, asset] of this.assets) if (asset.owner.runtimeId === runtimeId) this.deleteAsset(id);
  }

  private cancel(requestId: string, code: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const device = this.devices.get(pending.deviceId);
    this.receivingDevices.get(pending.deviceId)?.abort();
    if (device) {
      device.queue = device.queue.filter((command) => command.requestId !== requestId);
      if (device.queue.length >= 16) this.disconnect(pending.deviceId);
      else device.queue.push({ type: "cancel", requestId });
    }
    pending.reject(new DesktopCaptureError(code));
  }

  private deleteAsset(assetId: string): void {
    const asset = this.assets.get(assetId);
    if (!asset) return;
    this.processing.get(assetId)?.abort();
    clearTimeout(asset.timer);
    this.retainedBytes -= asset.data.byteLength;
    asset.data.fill(0);
    this.assets.delete(assetId);
  }

  private disconnect(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    clearTimeout(device.timer);
    this.devices.delete(deviceId);
    for (const [id, query] of this.inspections) if (query.deviceId === deviceId) this.cancelInspection(id, "DESKTOP_DISCONNECTED");
    this.receivingDevices.get(deviceId)?.abort();
    this.receivingDevices.delete(deviceId);
    for (const [id, pending] of this.pending) if (pending.deviceId === deviceId) this.cancel(id, "DESKTOP_DISCONNECTED");
    for (const [id, asset] of this.assets) if (asset.deviceId === deviceId) this.deleteAsset(id);
  }

  dispose(): void {
    for (const id of this.devices.keys()) this.disconnect(id);
    this.lastRequest.clear();
  }
}

export const desktopCaptureBroker = new DesktopCaptureBroker();
