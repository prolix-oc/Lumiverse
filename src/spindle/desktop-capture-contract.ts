export type DesktopCaptureKind = "image" | "video";

/** Metadata only. Discovery never captures pixels or grants permission. */
export interface DesktopCaptureDisplay {
  /** Opaque identity scoped to this desktop installation, instance and account. */
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface DesktopCaptureDevice {
  id: string;
  /** Stable across reconnects for this native installation, instance and account. Older clients omit this. */
  stableIdentity?: boolean;
  approvalStatusSupported?: boolean;
  /** Can finalize a video early through capture.finish(). */
  recordingControlSupported?: boolean;
  /** Connected displays; omitted by older desktop clients. Refresh listDevices for hotplug changes. */
  displays?: DesktopCaptureDisplay[];
  name: string;
  platform: "linux" | "macos" | "windows";
  capabilities: { image: boolean; video: boolean; replay: boolean };
  expiresAt: number;
}

export interface DesktopCaptureApprovalQuery {
  deviceId: string;
  displayId?: string;
  connectionId: string;
  kind: DesktopCaptureKind;
  userId?: string;
}

export interface DesktopCaptureApprovalStatus {
  deviceId: string;
  displayId?: string;
  kind: DesktopCaptureKind;
  approval: "required" | "remembered" | "paused" | "unavailable" | "unknown";
  source: "ready" | "missing" | "permission_required" | "unknown";
  checkedAt: number;
}

export type DesktopCaptureRequest = {
  deviceId: string;
  /** Caller-generated key, unique within the runtime/account, used to finish this request. */
  requestKey?: string;
  /** Capture this exact display with native approval. Omit to use Desktop's source picker. */
  displayId?: string;
  connectionId: string;
  purpose: string;
  userId?: string;
} & (
  | { kind: "image" }
  /** Record for at most 1–120 seconds. Native video is H.264 MP4, up to 1080p/30 FPS at an 8 Mbps target. */
  | { kind: "video"; mode: "record" | "replay"; durationSeconds: number }
);

export interface CapturedMediaRef {
  assetId: string;
  kind: DesktopCaptureKind;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds?: number;
  connectionId: string;
  expiresAt: number;
  /** Encoded size, when reported by the host. */
  byteSize?: number;
}

/** Host-side optimization. Bytes remain private and the handle keeps its original scope and expiry. */
export type DesktopCaptureOptimizeRequest = {
  assetId: string;
  connectionId: string;
  userId?: string;
} & (
  | { kind: "image"; maxEdge: number; format: "jpeg" | "webp" | "png"; quality: number }
  | { kind: "video"; maxEdge: number; fps: number; bitrateKbps: number }
);

export interface SpindleDesktopAPI {
  capture: {
    listDevices(options?: { userId?: string }): Promise<DesktopCaptureDevice[]>;
    /** Read-only advisory status for this extension, capture kind and exact destination. Never grants access. */
    getApprovalStatus(input: DesktopCaptureApprovalQuery): Promise<DesktopCaptureApprovalStatus>;
    request(input: DesktopCaptureRequest): Promise<CapturedMediaRef>;
    /** Requires desktop-capture-optimize-v1. Replaces this handle's media after a successful conversion.
     * No upscaling; video output is silent H.264 MP4. Failure leaves the original handle available.
     */
    optimize(input: DesktopCaptureOptimizeRequest): Promise<CapturedMediaRef>;
    /** Finalize a pending record-mode video. The original request resolves with the shorter clip.
     * Idempotent; false means the clip is already finished or no matching request exists.
     * Requires desktop-capture-finish-v1 and a device with recordingControlSupported.
     * This does not approve a source, bypass consent, or start another capture.
     */
    finish(requestKey: string, options?: { userId?: string }): Promise<boolean>;
    release(assetId: string, options?: { userId?: string }): Promise<void>;
  };
}

export type DesktopCaptureWorkerMessage =
  | { type: "desktop_capture_devices"; requestId: string; userId?: string }
  | { type: "desktop_capture_approval_status"; requestId: string; input: DesktopCaptureApprovalQuery }
  | { type: "desktop_capture_request"; requestId: string; input: DesktopCaptureRequest }
  | { type: "desktop_capture_optimize"; requestId: string; input: DesktopCaptureOptimizeRequest }
  | { type: "desktop_capture_finish"; requestId: string; requestKey: string; userId?: string }
  | { type: "desktop_capture_release"; requestId: string; assetId: string; userId?: string };

export interface DesktopCaptureDestination {
  connectionId: string;
  revision: string;
  provider: string;
  model: string;
  endpointOrigin: string;
}

export type DesktopCaptureCommand =
  | {
      type: "approval_status";
      requestId: string;
      displayId?: string;
      extension: { id: string; identifier: string; name: string; approvalRevision?: string };
      kind: DesktopCaptureKind;
      destination: DesktopCaptureDestination;
      expiresAt: number;
    }
  | {
      type: "capture";
      requestId: string;
      displayId?: string;
      extension: { id: string; identifier: string; name: string; approvalRevision?: string };
      purpose: string;
      kind: DesktopCaptureKind;
      mode?: "record" | "replay";
      durationSeconds?: number;
      destination: DesktopCaptureDestination;
      maxBytes: number;
      maxPixels: number;
      expiresAt: number;
    }
  | { type: "cancel"; requestId: string }
  | { type: "finish"; requestId: string };

export type DesktopCaptureReply =
  | {
      requestId: string;
      outcome: "approved";
      media: {
        mimeType: string;
        data: string;
        width: number;
        height: number;
        durationSeconds?: number;
      };
    }
  | { requestId: string; outcome: "denied" | "cancelled" | "unsupported" | "failed" };
