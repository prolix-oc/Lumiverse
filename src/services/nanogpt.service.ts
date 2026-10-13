import type { ConnectionProfile } from "../types/connection-profile";
import * as connSvc from "./connections.service";

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
const MAX_PENDING_OAUTH = 10_000;

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of pendingOAuth) {
    if (now - session.createdAt > OAUTH_TTL_MS) {
      pendingOAuth.delete(token);
    }
  }
  while (pendingOAuth.size >= MAX_PENDING_OAUTH) {
    const oldest = pendingOAuth.keys().next();
    if (oldest.done) break;
    pendingOAuth.delete(oldest.value);
  }
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

async function computeCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(hash).toString("base64url");
}

export async function initiateOAuthAsync(
  callbackUrl: string,
  opts: { connectionId?: string; connectionName?: string },
): Promise<{ auth_url: string; session_token: string }> {
  cleanupExpiredSessions();

  const codeVerifier = generateCodeVerifier();
  const sessionToken = crypto.randomUUID();
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  pendingOAuth.set(sessionToken, {
    connectionId: opts.connectionId,
    connectionName: opts.connectionName,
    codeVerifier,
    callbackUrl,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    callback_url: callbackUrl,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: "api.use models.read",
    state: sessionToken,
    client_name: "Lumiverse",
  });

  return {
    auth_url: `https://nano-gpt.com/auth?${params.toString()}`,
    session_token: sessionToken,
  };
}

export async function completeOAuth(
  userId: string,
  sessionToken: string,
  code: string,
): Promise<{ success: boolean; connection_id: string; created?: boolean; profile?: ConnectionProfile }> {
  const session = pendingOAuth.get(sessionToken);
  if (!session) throw new Error("Invalid or expired session token");

  if (Date.now() - session.createdAt > OAUTH_TTL_MS) {
    pendingOAuth.delete(sessionToken);
    throw new Error("OAuth session has expired");
  }

  let connectionId = session.connectionId;
  let created = false;

  if (connectionId) {
    const conn = connSvc.getConnection(userId, connectionId);
    if (!conn) throw new Error("Connection not found");
    if (conn.provider !== "nanogpt") throw new Error("Connection is not a NanoGPT profile");
  }

  const res = await fetch("https://nano-gpt.com/api/v1/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: session.codeVerifier,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    pendingOAuth.delete(sessionToken);
    throw new Error(`NanoGPT key exchange failed (${res.status}): ${err}`);
  }

  const data = (await res.json()) as { key?: string; access_token?: string };
  const apiKey = data.key || data.access_token;
  if (!apiKey) {
    pendingOAuth.delete(sessionToken);
    throw new Error("NanoGPT did not return an API key");
  }

  if (!connectionId) {
    const profile = await connSvc.createConnection(userId, {
      name: session.connectionName || "NanoGPT",
      provider: "nanogpt",
    });
    connectionId = profile.id;
    created = true;
  }

  await connSvc.setConnectionApiKey(userId, connectionId, apiKey);
  pendingOAuth.delete(sessionToken);

  const profile = connSvc.getConnection(userId, connectionId)!;
  return { success: true, connection_id: connectionId, created, profile };
}
