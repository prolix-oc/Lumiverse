/**
 * Dropbox OAuth routes — PKCE code-pairing flow (no redirect URI needed).
 *
 * Flow:
 *   1. GET  /auth           → returns auth_url + session_token
 *   2. POST /auth/callback  → user pastes the code, server exchanges via PKCE
 *   3. POST /auth/revoke    → revokes stored tokens
 *   4. GET  /auth/status    → checks if user has a valid token
 *   5. GET  /access-token   → returns fresh access token (refreshes if needed)
 *
 * No redirect URI is registered or sent. Dropbox displays the auth code
 * on-screen and the user copies it into Lumiverse. This means:
 *   - No redirect URI registration in the Dropbox App Console
 *   - Works from any origin (localhost, reverse proxy, etc.)
 *   - Zero friction for self-hosters
 */

import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import { getSecret, putSecret, deleteSecret } from "../services/secrets.service";

const app = new Hono();

// ─── Configuration ──────────────────────────────────────────────────────────

const DROPBOX_AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";

/**
 * Default App Key for Lumiverse's Dropbox app.
 * Safe to embed — app keys are public. Self-hosters can override via secrets.
 */
const DEFAULT_APP_KEY = "";

const DBX_APP_KEY_SECRET = "dropbox_app_key";
const DBX_REFRESH_TOKEN = "dropbox_refresh_token";
const DBX_ACCESS_TOKEN = "dropbox_access_token";
const DBX_ACCESS_EXPIRY = "dropbox_access_token_expiry";

async function getAppKey(userId: string): Promise<string | null> {
  const stored = await getSecret(userId, DBX_APP_KEY_SECRET);
  return stored || DEFAULT_APP_KEY || null;
}

// ─── PKCE helpers ───────────────────────────────────────────────────────────

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

// ─── Pending session store ──────────────────────────────────────────────────

interface PendingSession {
  userId: string;
  codeVerifier: string;
  createdAt: number;
}

const pendingSessions = new Map<string, PendingSession>();
const SESSION_TTL = 10 * 60 * 1000; // 10 minutes — user needs time to copy the code
const MAX_PENDING_SESSIONS = 50;

function cleanExpired() {
  const now = Date.now();
  for (const [token, session] of pendingSessions) {
    if (now - session.createdAt > SESSION_TTL) {
      pendingSessions.delete(token);
    }
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.use("/*", requireOwner);

// GET /auth — initiate OAuth flow (no redirect URI)
app.get("/auth", async (c) => {
  const userId = c.get("userId");
  const appKey = await getAppKey(userId);
  if (!appKey) {
    return c.json({ error: "Dropbox App Key not configured." }, 400);
  }

  cleanExpired();

  if (pendingSessions.size >= MAX_PENDING_SESSIONS) {
    return c.json({ error: "Too many pending OAuth sessions — wait a few minutes and retry" }, 429);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  const sessionToken = crypto.randomUUID();

  pendingSessions.set(sessionToken, {
    userId,
    codeVerifier,
    createdAt: Date.now(),
  });

  // No redirect_uri — Dropbox will display the code on screen
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    token_access_type: "offline",
  });

  return c.json({
    auth_url: `${DROPBOX_AUTH_URL}?${params.toString()}`,
    session_token: sessionToken,
  });
});

// POST /auth/callback — user pastes the code from Dropbox
app.post("/auth/callback", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { session_token, code } = body;

  if (!session_token || !code) {
    return c.json({ error: "session_token and code are required" }, 400);
  }

  const session = pendingSessions.get(session_token);
  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 400);
  }
  if (session.userId !== userId) {
    return c.json({ error: "Session does not belong to this user" }, 403);
  }

  pendingSessions.delete(session_token);

  const appKey = await getAppKey(userId);
  if (!appKey) {
    return c.json({ error: "Dropbox App Key not configured" }, 400);
  }

  // Exchange code for tokens — PKCE, no client_secret, no redirect_uri
  const tokenRes = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: appKey,
      code: code.trim(),
      code_verifier: session.codeVerifier,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return c.json({ error: `Token exchange failed: ${err}` }, 502);
  }

  const tokens = await tokenRes.json();

  if (tokens.refresh_token) {
    await putSecret(userId, DBX_REFRESH_TOKEN, tokens.refresh_token);
  }
  await putSecret(userId, DBX_ACCESS_TOKEN, tokens.access_token);
  await putSecret(userId, DBX_ACCESS_EXPIRY, String(Date.now() + (tokens.expires_in * 1000)));

  return c.json({ success: true });
});

// GET /auth/status
app.get("/auth/status", async (c) => {
  const userId = c.get("userId");
  const appKey = await getAppKey(userId);
  const customKey = await getSecret(userId, DBX_APP_KEY_SECRET);
  const refreshToken = await getSecret(userId, DBX_REFRESH_TOKEN);

  return c.json({
    configured: !!appKey,
    hasCustomAppKey: !!customKey,
    authorized: !!refreshToken,
  });
});

// PUT /auth/credentials — store custom App Key
app.put("/auth/credentials", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  if (body.appKey) {
    await putSecret(userId, DBX_APP_KEY_SECRET, body.appKey);
  }

  deleteSecret(userId, DBX_REFRESH_TOKEN);
  deleteSecret(userId, DBX_ACCESS_TOKEN);
  deleteSecret(userId, DBX_ACCESS_EXPIRY);

  return c.json({ success: true });
});

// DELETE /auth/credentials
app.delete("/auth/credentials", async (c) => {
  const userId = c.get("userId");
  deleteSecret(userId, DBX_APP_KEY_SECRET);
  deleteSecret(userId, DBX_REFRESH_TOKEN);
  deleteSecret(userId, DBX_ACCESS_TOKEN);
  deleteSecret(userId, DBX_ACCESS_EXPIRY);
  return c.json({ success: true });
});

// POST /auth/revoke
app.post("/auth/revoke", async (c) => {
  const userId = c.get("userId");
  const accessToken = await getSecret(userId, DBX_ACCESS_TOKEN);

  if (accessToken) {
    try {
      await fetch("https://api.dropboxapi.com/2/auth/token/revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch { /* ignore */ }
  }

  deleteSecret(userId, DBX_REFRESH_TOKEN);
  deleteSecret(userId, DBX_ACCESS_TOKEN);
  deleteSecret(userId, DBX_ACCESS_EXPIRY);

  return c.json({ success: true });
});

// GET /access-token — get a fresh access token
app.get("/access-token", async (c) => {
  const userId = c.get("userId");
  const appKey = await getAppKey(userId);
  if (!appKey) {
    return c.json({ error: "Dropbox App Key not configured" }, 400);
  }

  const refreshToken = await getSecret(userId, DBX_REFRESH_TOKEN);
  if (!refreshToken) {
    return c.json({ error: "Not authorized. Connect Dropbox first." }, 401);
  }

  const cachedToken = await getSecret(userId, DBX_ACCESS_TOKEN);
  const cachedExpiry = await getSecret(userId, DBX_ACCESS_EXPIRY);
  if (cachedToken && cachedExpiry) {
    const expiresAt = parseInt(cachedExpiry, 10);
    if (Date.now() < expiresAt - 60_000) {
      return c.json({ access_token: cachedToken });
    }
  }

  // Refresh — no client_secret needed
  const tokenRes = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: appKey,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return c.json({ error: `Token refresh failed: ${err}` }, 502);
  }

  const tokens = await tokenRes.json();
  await putSecret(userId, DBX_ACCESS_TOKEN, tokens.access_token);
  await putSecret(userId, DBX_ACCESS_EXPIRY, String(Date.now() + (tokens.expires_in * 1000)));

  return c.json({ access_token: tokens.access_token });
});

export { app as dropboxRoutes };
