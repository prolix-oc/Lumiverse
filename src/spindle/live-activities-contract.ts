/** Native iOS Live Activities (permission: `push_notification`). */
export type LiveActivityPresentation = {
  title: string;
  body?: string;
  /** SF Symbol name. Defaults to a symbol appropriate for the layout. */
  symbol?: string;
} & (
  | { layout: "status"; progress?: never; imageId?: never }
  | { layout: "progress"; progress: number; imageId?: never }
  | { layout: "image"; imageId: string; progress?: never }
);
export type LiveActivityStartInput = LiveActivityPresentation & {
  /** Idempotency key within this extension and user. */
  key: string;
  /** Active lifetime in seconds, 60–28,800; defaults to one hour. */
  durationSeconds?: number;
};
export interface LiveActivityResult {
  id: string;
  revision: number;
  state: "queued" | "active" | "ended";
}
export interface LiveActivityStatus {
  available: boolean;
  layouts: readonly ["status", "progress", "image"];
  /** This initial protocol requires a foreground native app to start. */
  remoteStart: false;
  enrolledDevices: number;
}
export interface SpindleLiveActivitiesAPI {
  getStatus(userId?: string): Promise<LiveActivityStatus>;
  /** Queues creation until an enrolled iOS app is open with Live Activities enabled. */
  start(input: LiveActivityStartInput, userId?: string): Promise<LiveActivityResult>;
  /** Replaces the complete presentation. Background updates use ActivityKit APNs. */
  update(id: string, presentation: LiveActivityPresentation, userId?: string): Promise<LiveActivityResult>;
  /** Ends the activity, retaining its latest presentation briefly on the Lock Screen. */
  end(id: string, userId?: string): Promise<LiveActivityResult>;
}
export type LiveActivityWorkerMessage = {
  type: "live_activity";
  requestId: string;
  operation: "status" | "start" | "update" | "end";
  id?: string;
  input?: LiveActivityStartInput | LiveActivityPresentation;
  userId?: string;
};
