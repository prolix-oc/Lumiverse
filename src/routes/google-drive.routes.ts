/**
 * Google Drive OAuth routes — PKCE flow for Desktop app credentials.
 *
 * Flow:
 *   1. GET  /auth          → returns auth_url + session_token
 *   2. GET  /oauth-landing  → unauthenticated, captures code from Google
 *   3. POST /auth/callback  → exchanges code for tokens, stores refresh token
 *   4. POST /auth/revoke    → revokes stored tokens
 *   5. GET  /auth/status    → checks if user has a valid token
 */

import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import { getSecret, putSecret, deleteSecret } from "../services/secrets.service";
import { env } from "../env";

const app = new Hono();

// ─── Configuration ──────────────────────────────────────────────────────────

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Secret keys for Google Drive OAuth credentials */
const GDRIVE_CLIENT_ID_KEY = "google_drive_client_id";
const GDRIVE_CLIENT_SECRET_KEY = "google_drive_client_secret";

/**
 * Default Client ID for Lumiverse's Google Cloud project.
 * Safe to embed — Client IDs are public by design.
 * Self-hosters can override by storing their own via the secrets API.
 */
const DEFAULT_CLIENT_ID = "";

async function getClientId(userId: string): Promise<string | null> {
  const stored = await getSecret(userId, GDRIVE_CLIENT_ID_KEY);
  return stored || DEFAULT_CLIENT_ID || null;
}

async function getClientSecret(userId: string): Promise<string | null> {
  return getSecret(userId, GDRIVE_CLIENT_SECRET_KEY);
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

// ─── Pending session store (in-memory, 5min TTL) ───────────────────────────

interface PendingSession {
  userId: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

const pendingSessions = new Map<string, PendingSession>();
const SESSION_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_PENDING_SESSIONS = 50;

function cleanExpired() {
  const now = Date.now();
  for (const [token, session] of pendingSessions) {
    if (now - session.createdAt > SESSION_TTL) {
      pendingSessions.delete(token);
    }
  }
}

// ─── Secret keys ────────────────────────────────────────────────────────────

const REFRESH_TOKEN_KEY = "google_drive_refresh_token";
const ACCESS_TOKEN_KEY = "google_drive_access_token";
const ACCESS_TOKEN_EXPIRY_KEY = "google_drive_access_token_expiry";

// ─── Routes ─────────────────────────────────────────────────────────────────

// All routes except the landing page require auth
app.use("/*", async (c, next) => {
  if (c.req.path.endsWith("/oauth-landing")) return next();
  return requireOwner(c, next);
});

// GET /auth — initiate OAuth flow
// Query: ?callback_url=<url>  — the frontend's origin-relative landing URL
app.get("/auth", async (c) => {
  const userId = c.get("userId");
  const clientId = await getClientId(userId);
  if (!clientId) {
    return c.json({ error: "Google Drive Client ID not configured. Set it in Settings." }, 400);
  }

  // The frontend passes its origin so the redirect works behind reverse proxies.
  // Fall back to the request's Origin/Referer header if not provided.
  let callbackUrl = c.req.query("callback_url");
  if (!callbackUrl) {
    const origin = c.req.header("origin") || c.req.header("referer")?.replace(/\/[^/]*$/, "") || `http://localhost:${env.port}`;
    callbackUrl = `${origin}/api/v1/google-drive/oauth-landing`;
  }

  cleanExpired();

  if (pendingSessions.size >= MAX_PENDING_SESSIONS) {
    return c.json({ error: "Too many pending OAuth sessions — wait a few minutes and retry" }, 429);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  const sessionToken = crypto.randomUUID();

  // The redirect URI is the frontend's origin + our landing path.
  // This must match what's registered in the Google Cloud Console.
  const redirectUri = callbackUrl;

  pendingSessions.set(sessionToken, {
    userId,
    codeVerifier,
    redirectUri,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state: sessionToken,
  });

  return c.json({
    auth_url: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    session_token: sessionToken,
  });
});

// GET /oauth-landing — unauthenticated callback from Google
app.get("/oauth-landing", (c) => {
  // Google redirects here with ?code=...&state=...
  // Serve a minimal page that passes the code back to the opener window
  const html = `<!DOCTYPE html>
<html><head><title>Lumiverse — Google Drive</title></head>
<body>
<p>Authorizing...</p>
<script>
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");

  if (window.opener) {
    window.opener.postMessage({
      type: "GOOGLE_DRIVE_OAUTH",
      code: code,
      state: state,
      error: error,
    }, window.location.origin);
    window.close();
  } else {
    // textContent avoids HTML injection from the error query param
    document.body.textContent = error
      ? "Authorization failed: " + error
      : "Authorization complete. You can close this window.";
  }
</script>
</body></html>`;

  return c.html(html);
});

// POST /auth/callback — exchange code for tokens
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

  const clientId = await getClientId(userId);
  if (!clientId) {
    return c.json({ error: "Google Drive Client ID not configured" }, 400);
  }

  // Exchange authorization code for tokens
  const tokenParams: Record<string, string> = {
    client_id: clientId,
    code,
    code_verifier: session.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: session.redirectUri,
  };

  // Web application credentials require client_secret; Desktop credentials don't.
  const clientSecret = await getClientSecret(userId);
  if (clientSecret) {
    tokenParams.client_secret = clientSecret;
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(tokenParams),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return c.json({ error: `Token exchange failed: ${err}` }, 502);
  }

  const tokens = await tokenRes.json();
  const { access_token, refresh_token, expires_in } = tokens;

  // Store refresh token encrypted
  if (refresh_token) {
    putSecret(userId, REFRESH_TOKEN_KEY, refresh_token);
  }

  // Cache access token + expiry
  putSecret(userId, ACCESS_TOKEN_KEY, access_token);
  putSecret(userId, ACCESS_TOKEN_EXPIRY_KEY, String(Date.now() + (expires_in * 1000)));

  return c.json({ success: true });
});

// GET /auth/status — check if user has valid Google Drive auth
app.get("/auth/status", async (c) => {
  const userId = c.get("userId");
  const clientId = await getClientId(userId);
  const customClientId = await getSecret(userId, GDRIVE_CLIENT_ID_KEY);
  const customSecret = await getSecret(userId, GDRIVE_CLIENT_SECRET_KEY);
  const refreshToken = await getSecret(userId, REFRESH_TOKEN_KEY);

  return c.json({
    configured: !!clientId,
    hasCustomCredentials: !!customClientId,
    hasClientSecret: !!customSecret,
    authorized: !!refreshToken,
  });
});

// PUT /auth/credentials — store custom OAuth credentials (encrypted)
app.put("/auth/credentials", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { clientId, clientSecret } = body;

  if (clientId) {
    await putSecret(userId, GDRIVE_CLIENT_ID_KEY, clientId);
  }
  if (clientSecret) {
    await putSecret(userId, GDRIVE_CLIENT_SECRET_KEY, clientSecret);
  }

  // Clear any existing tokens since credentials changed
  deleteSecret(userId, REFRESH_TOKEN_KEY);
  deleteSecret(userId, ACCESS_TOKEN_KEY);
  deleteSecret(userId, ACCESS_TOKEN_EXPIRY_KEY);

  return c.json({ success: true });
});

// DELETE /auth/credentials — remove custom credentials, revert to default
app.delete("/auth/credentials", async (c) => {
  const userId = c.get("userId");
  deleteSecret(userId, GDRIVE_CLIENT_ID_KEY);
  deleteSecret(userId, GDRIVE_CLIENT_SECRET_KEY);
  deleteSecret(userId, REFRESH_TOKEN_KEY);
  deleteSecret(userId, ACCESS_TOKEN_KEY);
  deleteSecret(userId, ACCESS_TOKEN_EXPIRY_KEY);

  return c.json({ success: true });
});

// POST /auth/revoke — revoke and delete stored tokens
app.post("/auth/revoke", async (c) => {
  const userId = c.get("userId");
  const accessToken = await getSecret(userId, ACCESS_TOKEN_KEY);

  // Best-effort revoke at Google
  if (accessToken) {
    try {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${accessToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    } catch { /* ignore */ }
  }

  deleteSecret(userId, REFRESH_TOKEN_KEY);
  deleteSecret(userId, ACCESS_TOKEN_KEY);
  deleteSecret(userId, ACCESS_TOKEN_EXPIRY_KEY);

  return c.json({ success: true });
});

// GET /access-token — get a fresh access token (refreshes if needed)
// Used internally by the migration flow to construct the FileSystem config
app.get("/access-token", async (c) => {
  const userId = c.get("userId");
  const clientId = await getClientId(userId);
  if (!clientId) {
    return c.json({ error: "Google Drive Client ID not configured" }, 400);
  }

  const refreshToken = await getSecret(userId, REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    return c.json({ error: "Not authorized. Connect Google Drive first." }, 401);
  }

  // Check if cached access token is still valid
  const cachedToken = await getSecret(userId, ACCESS_TOKEN_KEY);
  const cachedExpiry = await getSecret(userId, ACCESS_TOKEN_EXPIRY_KEY);
  if (cachedToken && cachedExpiry) {
    const expiresAt = parseInt(cachedExpiry, 10);
    if (Date.now() < expiresAt - 60_000) {
      // Still valid (with 1min buffer)
      return c.json({ access_token: cachedToken });
    }
  }

  // Refresh
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return c.json({ error: `Token refresh failed: ${err}` }, 502);
  }

  const tokens = await tokenRes.json();
  putSecret(userId, ACCESS_TOKEN_KEY, tokens.access_token);
  putSecret(userId, ACCESS_TOKEN_EXPIRY_KEY, String(Date.now() + (tokens.expires_in * 1000)));

  return c.json({ access_token: tokens.access_token });
});

export { app as googleDriveRoutes };
