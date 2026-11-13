import type { LocalServerSource } from "./local-server";

export interface LocalInstanceConnection {
  mode: "local";
}

export interface RemoteInstanceConnection {
  mode: "remote";
  /** Canonical server origin. Authentication and API calls never inherit paths. */
  origin: string;
  /** Filled after the server has identified itself. */
  instanceId?: string;
  displayName?: string;
}

export type InstanceConnection = LocalInstanceConnection | RemoteInstanceConnection;

export interface InstanceConnectionChange {
  connection: InstanceConnection;
  localServerSource?: LocalServerSource;
  repoDir?: string;
  bunPath?: string;
}

export const LOCAL_INSTANCE_CONNECTION: LocalInstanceConnection = Object.freeze({ mode: "local" });

export function savedConnectionPreferences(active: unknown, rememberedRemote: unknown, legacyUrl?: unknown): {
  connection: InstanceConnection; configured: boolean; remote: RemoteInstanceConnection | null;
} {
  const connection = normalizeInstanceConnection(active, legacyUrl);
  const remembered = normalizeInstanceConnection(rememberedRemote);
  return {
    connection,
    configured: connection.mode === "remote" || Boolean(active && typeof active === "object" && (active as { mode?: unknown }).mode === "local"),
    remote: connection.mode === "remote" ? connection : remembered.mode === "remote" ? remembered : null,
  };
}

export function normalizeRemoteOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Use an https:// URL, or http://localhost for local development.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("Remote Lumiverse instances, including LAN addresses, must use HTTPS with a trusted certificate matching the hostname or IP address.");
  }
  if (url.username || url.password) {
    throw new Error("The instance URL must not contain a username or password.");
  }
  return url.origin;
}

export function normalizeInstanceConnection(
  value: unknown,
  legacyCustomFrontendUrl?: unknown,
): InstanceConnection {
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (candidate.mode === "local") return LOCAL_INSTANCE_CONNECTION;
    if (candidate.mode === "remote" && typeof candidate.origin === "string") {
      try {
        return {
          mode: "remote",
          origin: normalizeRemoteOrigin(candidate.origin),
          ...(typeof candidate.instanceId === "string" ? { instanceId: candidate.instanceId } : {}),
          ...(typeof candidate.displayName === "string" ? { displayName: candidate.displayName } : {}),
        };
      } catch {
        return LOCAL_INSTANCE_CONNECTION;
      }
    }
  }

  // Migrate the former URL-only setting without leaving local runner controls
  // pointed at a remote frontend.
  if (typeof legacyCustomFrontendUrl === "string" && legacyCustomFrontendUrl.trim()) {
    try {
      return { mode: "remote", origin: normalizeRemoteOrigin(legacyCustomFrontendUrl) };
    } catch {
      return LOCAL_INSTANCE_CONNECTION;
    }
  }
  return LOCAL_INSTANCE_CONNECTION;
}
