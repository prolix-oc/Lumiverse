import { createProviderPkce, exchangeProviderPkce } from "./provider-pkce";
import { getProvider } from "../llm/registry";
import { OpenRouterProvider, type OpenRouterCreditsInfo, type OpenRouterModelInfo, type OpenRouterProviderEntry } from "../llm/providers/openrouter";
import type { ConnectionProfile } from "../types/connection-profile";
import * as connSvc from "./connections.service";
import * as secretsSvc from "./secrets.service";

// ── PKCE OAuth ───────────────────────────────────────────────────────────────

interface PendingOAuth {
  connectionId?: string;
  connectionName?: string;
  codeVerifier: string;
  callbackUrl: string;
  createdAt: number;
}

/** In-memory store for pending OAuth sessions. Keyed by session_token. TTL: 5 minutes. */
const pendingOAuth = new Map<string, PendingOAuth>();
const OAUTH_TTL_MS = 5 * 60 * 1000;
/**
 * Hard cap so an attacker can't keep calling /openrouter/auth and pin entries
 * indefinitely. cleanupExpiredSessions is also called from initiate, so the
 * common case is bounded; this is a backstop for adversarial loops.
 */
const MAX_PENDING_OAUTH = 10_000;

/** Periodically clean up expired sessions. */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of pendingOAuth) {
    if (now - session.createdAt > OAUTH_TTL_MS) {
      pendingOAuth.delete(token);
    }
  }
  // FIFO eviction if the map is still over the cap after expiry sweep.
  while (pendingOAuth.size >= MAX_PENDING_OAUTH) {
    const oldest = pendingOAuth.keys().next();
    if (oldest.done) break;
    pendingOAuth.delete(oldest.value);
  }
}

export async function initiateOAuthAsync(
  callbackUrl: string,
  opts: { connectionId?: string; connectionName?: string },
): Promise<{ auth_url: string; session_token: string }> {
  cleanupExpiredSessions();

  const { auth_url, session_token, codeVerifier, callbackUrl: callbackUrlWithState } = await createProviderPkce("openrouter", callbackUrl);
  pendingOAuth.set(session_token, {
    connectionId: opts.connectionId,
    connectionName: opts.connectionName,
    codeVerifier,
    callbackUrl: callbackUrlWithState,
    createdAt: Date.now(),
  });
  return { auth_url, session_token };
}

/**
 * Complete the PKCE OAuth flow: exchange the authorization code for an API key,
 * then store it as the connection's encrypted API key.
 *
 * If the session was initiated without an existing connection (creation flow),
 * the connection is auto-created here so orphaned profiles are avoided when the
 * user cancels the popup.
 */
export async function completeOAuth(
  userId: string,
  sessionToken: string,
  code: string,
): Promise<{ success: boolean; connection_id: string; created?: boolean; profile?: ConnectionProfile }> {
  const session = pendingOAuth.get(sessionToken);
  if (!session) throw new Error("Invalid or expired session token");

  // Check TTL
  if (Date.now() - session.createdAt > OAUTH_TTL_MS) {
    pendingOAuth.delete(sessionToken);
    throw new Error("OAuth session has expired");
  }

  let connectionId = session.connectionId;
  let created = false;

  if (connectionId) {
    // Existing connection — verify it belongs to this user
    const conn = connSvc.getConnection(userId, connectionId);
    if (!conn) throw new Error("Connection not found");
    if (conn.provider !== "openrouter") throw new Error("Connection is not an OpenRouter profile");
  }

  let apiKey: string;
  try {
    apiKey = await exchangeProviderPkce("openrouter", code, session.codeVerifier);
  } catch (error) {
    pendingOAuth.delete(sessionToken);
    throw error;
  }

  // Auto-create connection if this was a creation-time OAuth flow
  if (!connectionId) {
    const profile = await connSvc.createConnection(userId, {
      name: session.connectionName || "OpenRouter",
      provider: "openrouter",
    });
    connectionId = profile.id;
    created = true;
  }

  // Store the key as the connection's API key
  await connSvc.setConnectionApiKey(userId, connectionId, apiKey);

  // Clean up
  pendingOAuth.delete(sessionToken);

  const profile = connSvc.getConnection(userId, connectionId)!;
  return { success: true, connection_id: connectionId, created, profile };
}

// ── Credits & Usage ──────────────────────────────────────────────────────────

function getOpenRouterProvider(): OpenRouterProvider {
  const provider = getProvider("openrouter");
  if (!provider || !(provider instanceof OpenRouterProvider)) {
    throw new Error("OpenRouter provider not registered");
  }
  return provider;
}

export async function fetchCredits(userId: string, connectionId: string): Promise<OpenRouterCreditsInfo | null> {
  const conn = connSvc.getConnection(userId, connectionId);
  if (!conn || conn.provider !== "openrouter") return null;

  const apiKey = await secretsSvc.getSecret(userId, connSvc.connectionSecretKey(connectionId));
  if (!apiKey) return null;

  const provider = getOpenRouterProvider();
  return provider.fetchCredits(apiKey, connSvc.resolveEffectiveApiUrl(conn));
}

// ── Model Metadata ───────────────────────────────────────────────────────────

export async function fetchModelsWithMetadata(userId: string, connectionId: string): Promise<OpenRouterModelInfo[] | null> {
  const conn = connSvc.getConnection(userId, connectionId);
  if (!conn || conn.provider !== "openrouter") return null;

  const apiKey = await secretsSvc.getSecret(userId, connSvc.connectionSecretKey(connectionId));
  if (!apiKey) return null;

  const provider = getOpenRouterProvider();
  return provider.fetchModelsWithMetadata(apiKey, connSvc.resolveEffectiveApiUrl(conn));
}

// ── Generation Stats ─────────────────────────────────────────────────────────

export async function fetchGenerationStats(userId: string, connectionId: string, generationId: string): Promise<any | null> {
  const conn = connSvc.getConnection(userId, connectionId);
  if (!conn || conn.provider !== "openrouter") return null;

  const apiKey = await secretsSvc.getSecret(userId, connSvc.connectionSecretKey(connectionId));
  if (!apiKey) return null;

  const provider = getOpenRouterProvider();
  return provider.fetchGenerationStats(apiKey, connSvc.resolveEffectiveApiUrl(conn), generationId);
}

// ── Provider List ────────────────────────────────────────────────────────────

export async function fetchProviderList(userId: string, connectionId: string): Promise<OpenRouterProviderEntry[] | null> {
  const conn = connSvc.getConnection(userId, connectionId);
  if (!conn || conn.provider !== "openrouter") return null;

  const apiKey = await secretsSvc.getSecret(userId, connSvc.connectionSecretKey(connectionId));
  if (!apiKey) return null;

  const provider = getOpenRouterProvider();
  return provider.fetchProviderList(apiKey, connSvc.resolveEffectiveApiUrl(conn));
}

export async function fetchModelEndpoints(userId: string, connectionId: string, model: string): Promise<OpenRouterProviderEntry[] | null> {
  const conn = connSvc.getConnection(userId, connectionId);
  if (!conn || conn.provider !== "openrouter") return null;

  const apiKey = await secretsSvc.getSecret(userId, connSvc.connectionSecretKey(connectionId));
  if (!apiKey) return null;

  return getOpenRouterProvider().fetchModelEndpoints(apiKey, connSvc.resolveEffectiveApiUrl(conn), model);
}
