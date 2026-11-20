import { getProvider } from "../../llm/registry";
import type { LlmProvider } from "../../llm/provider";
import type { ConnectionProfile } from "../../types/connection-profile";
import { ConnectionCredentialError } from "../../utils/provider-errors";
import * as connectionsSvc from "../connections.service";
import * as secretsSvc from "../secrets.service";

export interface ResolveChatGenerationConnectionOptions {
  preferActiveConnection?: boolean;
  authoritativeConnectionId?: string;
}

/**
 * Resolve the connection used by a chat generation. A chat-scoped binding is
 * authoritative over the caller's active/global connection. If the bound
 * profile was deleted, fall back to the requested/default profile so an old
 * metadata reference cannot make the chat unusable.
 *
 * When no `connection_id` was supplied by the caller, the fallback is the
 * acting connection: validated active profile, default profile, then any
 * owned profile. A supplied-but-stale id still throws rather than silently
 * retargeting.
 *
 * `preferActiveConnection` is used only by Edit-and-Send dispatches.
 * `authoritativeConnectionId` is the connection recorded when an
 * Edit-and-Send request was committed and therefore takes precedence over all
 * live settings.
 */
export function resolveChatGenerationConnection(
  userId: string,
  metadata: Record<string, any> | null | undefined,
  requestedConnectionId?: string,
  opts?: ResolveChatGenerationConnectionOptions,
): ConnectionProfile {
  const requestedId = requestedConnectionId?.trim() || undefined;

  // A committed Edit-and-Send connection is the first rung. If it was deleted
  // after commit, continue down the live fallback ladder so the request does
  // not become permanently stranded.
  const authoritativeId = opts?.authoritativeConnectionId?.trim() || undefined;
  if (authoritativeId) {
    const committed = connectionsSvc.resolveConnection(userId, authoritativeId);
    if (committed) {
      const pinnedId = typeof metadata?.connection_profile_id === "string"
        ? metadata.connection_profile_id.trim()
        : "";
      const committedIsPinned = pinnedId !== "" && pinnedId === committed.id;
      const pinnedModel = committedIsPinned && typeof metadata?.connection_model === "string"
        ? metadata.connection_model.trim()
        : "";
      return pinnedModel ? { ...committed, model: pinnedModel } : committed;
    }
  }

  // Edit-and-Send can explicitly prefer the strict active profile. Do not
  // carry a model override from a different, chat-pinned connection.
  if (opts?.preferActiveConnection && !requestedId) {
    const activeId = connectionsSvc.resolveActiveConnectionId(userId);
    if (activeId) {
      const activeConnection = connectionsSvc.resolveConnection(userId, activeId);
      if (activeConnection) return activeConnection;
    }
  }

  const boundId = typeof metadata?.connection_profile_id === "string"
    ? metadata.connection_profile_id.trim()
    : "";
  const boundConnection = boundId
    ? connectionsSvc.resolveConnection(userId, boundId)
    : null;
  const connection = boundConnection
    ?? connectionsSvc.resolveConnection(
      userId,
      requestedId ?? connectionsSvc.resolveActiveConnectionId(userId),
    )
    ?? (requestedId
      ? null
      : connectionsSvc.resolveConnection(
        userId,
        connectionsSvc.resolveActingConnectionId(userId),
      ));

  if (!connection) {
    throw new Error("No connection profile found. Configure a default connection or select one for this chat.");
  }

  const modelOverride = boundConnection && typeof metadata?.connection_model === "string"
    ? metadata.connection_model.trim()
    : "";
  return modelOverride ? { ...connection, model: modelOverride } : connection;
}

/** Resolve a connection profile by ID or fall back to the user's default. */
export function resolveConnection(
  userId: string,
  connectionId?: string,
): ConnectionProfile {
  const connection = connectionsSvc.resolveConnection(userId, connectionId);
  if (!connection) {
    throw new Error("No connection profile found. Create one first.");
  }
  return connection;
}

/** Resolve a provider, credential, and URL from a connection profile. */
export async function resolveProviderAndKey(
  userId: string,
  connectionId: string,
): Promise<{
  provider: LlmProvider;
  apiKey: string;
  apiUrl: string;
  connection: ConnectionProfile;
}> {
  const connection = connectionsSvc.resolveConnection(userId, connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  const provider = getProvider(connection.provider);
  if (!provider) {
    throw new Error(`Unknown provider: ${connection.provider}`);
  }

  const secretKeyName = connectionsSvc.connectionSecretKey(connection.id);
  const apiKey = await secretsSvc.getSecret(userId, secretKeyName);
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    throw new Error(
      `No API key found for connection "${connection.name}". Add one via the connection settings.`,
    );
  }

  // A profile that claims to have a key but cannot resolve it is broken. A
  // profile that never had one remains valid for keyless local providers.
  if (!apiKey && connection.has_api_key) {
    throw new ConnectionCredentialError({
      connectionId: connection.id,
      connectionName: connection.name,
      provider: provider.displayName,
      secretKeyName,
    });
  }

  return {
    provider,
    apiKey: apiKey || "",
    apiUrl: connectionsSvc.resolveEffectiveApiUrl(connection),
    connection,
  };
}
