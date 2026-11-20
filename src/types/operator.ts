// ─── IPC Message Protocol ────────────────────────────────────────────────────
// All messages between runner (parent) and server (child) use this envelope.

export interface IPCMessage {
  type: string;
  id?: string;
  payload?: unknown;
}

// ─── Server → Runner request types ──────────────────────────────────────────

export type IPCRequestType =
  | "status"
  | "check-updates"
  | "apply-update"
  | "switch-branch"
  | "toggle-remote"
  | "restart"
  | "quit"
  | "clear-cache"
  | "ensure-deps"
  | "rebuild-frontend";

export interface IPCRequest extends IPCMessage {
  type: IPCRequestType;
  id: string;
  payload?: {
    target?: string;     // for switch-branch
    enable?: boolean;    // for toggle-remote
  };
}

// ─── Runner → Server response types ─────────────────────────────────────────

export interface IPCResponse extends IPCMessage {
  type: "response";
  id: string;
  payload: {
    success: boolean;
    data?: unknown;
    error?: string;
  };
}

export interface IPCProgress extends IPCMessage {
  type: "progress";
  id: string;
  payload: {
    operation: string;
    message: string;
    step?: number;
  };
}

export interface IPCReady extends IPCMessage {
  type: "ready";
  payload: {
    port: number;
    pid: number;
  };
}

// ─── Shared data shapes ─────────────────────────────────────────────────────

export type OperatorIpcReason =
  | "connected"
  | "not_started_with_runner"
  | "runner_env_without_process_send";

export interface LogEntry {
  timestamp: number;
  source: "stdout" | "stderr";
  text: string;
}

export interface OperatorStatus {
  port: number;
  pid: number;
  uptime: number;
  branch: string;
  version: string;
  commit: string;
  remoteMode: boolean;
  ipcAvailable: boolean;
  ipcReason: OperatorIpcReason;
  updateAvailable: boolean;
  commitsBehind: number;
  latestUpdateMessage: string;
}

export interface UpdateCheckResult {
  available: boolean;
  commitsBehind: number;
  latestMessage: string;
}
