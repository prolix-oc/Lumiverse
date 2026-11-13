export type RemoteConnectionState =
  | "authorizing"
  | "disconnected"
  | "connected"
  | "restricted"
  | "unreachable"
  | "reauth_required";

export interface RemoteInstanceIdentity {
  id: string;
  name: string;
}

export interface RemoteAccount {
  id: string;
  name: string;
  username: string | null;
  role: string;
}

export interface RemoteOperatorStatus {
  port: number;
  pid: number;
  uptime: number;
  branch: string;
  version: string;
  commit: string;
  remoteMode: boolean;
  ipcAvailable: boolean;
  updateAvailable: boolean;
  commitsBehind: number;
  latestUpdateMessage: string;
}

export interface RemoteInstanceSnapshot {
  state: RemoteConnectionState;
  origin: string;
  instance: RemoteInstanceIdentity | null;
  account: RemoteAccount | null;
  status: RemoteOperatorStatus | null;
  error: string | null;
  credentialPersisted: boolean;
}

export function pendingRemoteSnapshot(origin: string): RemoteInstanceSnapshot {
  return {
    state: "authorizing",
    origin,
    instance: null,
    account: null,
    status: null,
    error: null,
    credentialPersisted: false,
  };
}
