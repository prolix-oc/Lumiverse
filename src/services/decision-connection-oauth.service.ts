import { DecisionValidationError, isRecord } from "../decision/validation";
import { resolveDecisionApiUrl } from "../decision/providers";
import type { CreateDecisionConnectionInput, DecisionConnectionProfile } from "../types/decision-connection";
import * as connections from "./decision-connections.service";
import { createProviderPkce, exchangeProviderPkce, type PkceProvider } from "./provider-pkce";

interface PendingOAuth {
  userId: string;
  provider: PkceProvider;
  connectionId?: string;
  connection?: CreateDecisionConnectionInput;
  codeVerifier: string;
  createdAt: number;
}
const pending = new Map<string, PendingOAuth>();
const TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 10_000;

function checkEndpoint(profile: { provider: string; api_url?: string }) {
  if (resolveDecisionApiUrl(profile) !== resolveDecisionApiUrl({ provider: profile.provider })) {
    throw new DecisionValidationError("Use the provider's default API URL to sign in");
  }
}

function existingConnection(userId: string, id: string, provider: PkceProvider): DecisionConnectionProfile {
  const profile = connections.getConnection(userId, id);
  if (!profile) throw new DecisionValidationError("Decision connection not found");
  if (profile.provider !== provider) throw new DecisionValidationError("Decision connection provider has changed");
  checkEndpoint(profile);
  return profile;
}

/** Creates only a pending session; no connection or secret exists until success. */
export async function initiateOAuth(userId: string, provider: string, input: unknown, origin: string) {
  if (provider !== "openrouter" && provider !== "nanogpt") throw new DecisionValidationError("This provider does not support sign-in");
  if (!isRecord(input) || typeof input.callback_url !== "string") throw new DecisionValidationError("callback_url is required");
  let callback: URL;
  try { callback = new URL(input.callback_url); }
  catch { throw new DecisionValidationError("Invalid callback URL"); }
  if (callback.origin !== origin || callback.pathname !== `/api/v1/${provider}/oauth-landing` || callback.username || callback.password || callback.hash) {
    throw new DecisionValidationError("Use the same-origin provider callback URL");
  }
  const hasId = input.connection_id !== undefined;
  if (hasId === (input.connection !== undefined)) throw new DecisionValidationError("Provide either connection_id or connection");
  let connection: CreateDecisionConnectionInput | undefined;
  let connectionId: string | undefined;
  if (hasId) {
    if (typeof input.connection_id !== "string" || !input.connection_id) throw new DecisionValidationError("connection_id must be a nonempty string");
    connectionId = input.connection_id;
    existingConnection(userId, connectionId, provider);
  } else {
    connections.validateConnectionInput(input.connection);
    if (input.connection.provider !== provider) throw new DecisionValidationError("Decision connection provider does not match sign-in provider");
    checkEndpoint(input.connection);
    // Only the exchanged credential is saved; never retain a manually typed key.
    connection = structuredClone({ ...input.connection, api_key: undefined });
  }
  const now = Date.now();
  for (const [token, session] of pending) if (now - session.createdAt > TTL_MS) pending.delete(token);
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
  const { auth_url, session_token, codeVerifier } = await createProviderPkce(provider, callback.toString());
  pending.set(session_token, { userId, provider, connectionId, connection, codeVerifier, createdAt: now });
  return { auth_url, session_token };
}

export async function completeOAuth(userId: string, input: unknown) {
  if (!isRecord(input) || typeof input.session_token !== "string" || !input.session_token || typeof input.code !== "string" || !input.code.trim()) {
    throw new DecisionValidationError("session_token and code are required");
  }
  const session = pending.get(input.session_token);
  if (!session || session.userId !== userId) throw new DecisionValidationError("Invalid or expired sign-in session");
  // Consume before any asynchronous work so simultaneous callbacks cannot replay.
  pending.delete(input.session_token);
  if (Date.now() - session.createdAt > TTL_MS) throw new DecisionValidationError("Sign-in session has expired");
  if (session.connectionId) existingConnection(userId, session.connectionId, session.provider);
  let apiKey: string;
  try { apiKey = await exchangeProviderPkce(session.provider, input.code, session.codeVerifier); }
  catch { throw new DecisionValidationError("Provider sign-in failed. Please try again."); }
  let profile: DecisionConnectionProfile;
  if (session.connectionId) {
    // Recheck after exchange in case the connection was edited during sign-in.
    existingConnection(userId, session.connectionId, session.provider);
    profile = (await connections.updateConnection(userId, session.connectionId, { api_key: apiKey }))!;
  } else {
    profile = await connections.createConnection(userId, { ...session.connection!, api_key: apiKey });
  }
  return { success: true, connection_id: profile.id, created: !session.connectionId, profile };
}
