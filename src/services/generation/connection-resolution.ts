import { getProvider } from "../../llm/registry";
import type { LlmProvider } from "../../llm/provider";
import type { ConnectionProfile } from "../../types/connection-profile";
import { ConnectionCredentialError } from "../../utils/provider-errors";
import * as connectionsSvc from "../connections.service";
import * as secretsSvc from "../secrets.service";

export interface ResolveChatGenerationConnectionOptions {
  preferActiveConnection?: boolean;
  authoritativeConnectionId?: string;
  /**
   * The chat's character id, driving the per-character connection binding
   * ("bind to char") rung. Supplied by the generate.service call sites from
   * the loaded chat; `null`/`undefined` (or a group-chat metadata flag) leaves
   * the rung inert.
   */
  characterId?: string | null;
}

/**
 * Resolve the connection used by a chat generation. The ladder, most
 * specific first:
 *
 *   1. a committed Edit-and-Send connection (`authoritativeConnectionId`)
 *   2. the `editAndSendAlwaysUseActiveConnection` opt-in → STRICT active
 *      profile (`preferActiveConnection`, Edit-and-Send dispatch only)
 *   3. a live chat-scoped `connection_profile_id` pin
 *   4. a live per-character connection binding ("bind to char",
 *      `opts.characterId`) — SKIPPED in group chats (`metadata.group === true`),
 *      matching the preset-profile precedent: per-member bindings would be
 *      ambiguous (which member wins?)
 *   5. the requested connection id / active profile
 *   6. the acting chain (active → default → any owned profile), only when no
 *      id was supplied
 *
 * The character binding selects a CONNECTION only, never a model: the chat-pin
 * `connection_model` override is applied exclusively when the CHAT pin (rung
 * 3) won and never travels with a character binding, because a model name
 * validated against one endpoint is routinely absent from another.
 *
 * If a bound profile (chat pin or character binding) was deleted, fall back to
 * the requested/default profile so an old metadata/settings reference cannot
 * make the chat unusable. A supplied-but-stale REQUESTED id still throws
 * rather than silently retargeting.
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

  // Character binding rung ("bind to char"): below the chat pin, above the
  // requested/active connection, and skipped in group chats. Resolved with
  // `resolveConnection` — roulette-aware, exactly like the pin rung — and a
  // binding naming a deleted profile simply yields null here so resolution
  // falls through to the requested/active connection without bricking the
  // chat (`deleteConnection` prunes such bindings, but a race or a restored
  // database can still surface one).
  const characterBindId = !boundConnection && metadata?.group !== true && opts?.characterId
    ? connectionsSvc.getCharacterConnectionBind(userId, opts.characterId)
    : null;
  const characterBoundConnection = characterBindId
    ? connectionsSvc.resolveConnection(userId, characterBindId)
    : null;

  const connection = boundConnection
    ?? characterBoundConnection
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

  // The model override belongs to the CHAT pin only (`boundConnection`):
  // never to a character binding, which pins a connection, not a model.
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
