import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import legacy from "./test-fixtures/better-auth-1.7.2.json";

// This fixture contains only synthetic users and credentials, issued by the
// actual previous library version (not cookies re-signed by the new version).
const directory = mkdtempSync(join(tmpdir(), "lumiverse-auth-upgrade-"));
process.env.DATA_DIR = directory;
process.env.AUTH_SECRET = legacy.secret;
process.env.LUMIVERSE_BUNDLE_ID = "auth-upgrade-test";
delete process.env.AUTH_BASE_URL;
process.env.TRUSTED_ORIGINS = "http://localhost:7860";

const { initIdentity } = await import("../crypto/init");
const { initDatabase, closeDatabase } = await import("../db/connection");
const { runMigrations } = await import("../db/migrate");
await initIdentity();
const db = initDatabase(":memory:");
db.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
// Recreate the two auth schema differences on an otherwise up-to-date install.
db.run(`
  DROP INDEX account_provider_accountId_uidx;
  ALTER TABLE account ADD COLUMN issuer TEXT NOT NULL DEFAULT 'local:credential';
  CREATE UNIQUE INDEX account_issuer_accountId_uidx ON account(issuer, accountId);
  ALTER TABLE session DROP COLUMN impersonatedBy;
  CREATE TABLE _migrations (name TEXT NOT NULL UNIQUE);
`);
for (const name of readdirSync(join(import.meta.dir, "../db/migrations"))) {
  if (name.endsWith(".sql") && !/^(134|135)_/.test(name)) {
    db.run("INSERT INTO _migrations (name) VALUES (?)", [name]);
  }
}

function insertFixture(table: string, row: Record<string, unknown>) {
  // Preserve Better Auth's actual serialized dates even though Lumiverse's
  // historical schema declares INTEGER affinity for these SQLite columns.
  const entries = Object.entries(row).filter(([key]) => key !== "impersonatedBy");
  const columns = entries.map(([key]) => `"${key}"`).join(", ");
  const values = entries.map(([, value]) => value);
  db.run(`INSERT INTO "${table}" (${columns}) VALUES (${values.map(() => "?").join(", ")})`, values as any[]);
}
for (const row of legacy.users) insertFixture("user", row);
for (const row of legacy.accounts) insertFixture("account", row);
for (const row of legacy.sessions) insertFixture("session", row);
const owner = legacy.users[0]!;
const aliasUser = { ...owner, id: "alias-user", username: "aliasowner", email: "alias-owner@example.test" };
insertFixture("user", aliasUser);
for (const [provider, user] of [["authentik", owner], ["authentik-alias", aliasUser]] as const) {
  db.run(`INSERT INTO account (id, accountId, providerId, issuer, userId, accessToken, refreshToken)
    VALUES (?, 'shared-subject', ?, ?, ?, 'old-access-token', 'old-refresh-token')`,
  [`link-${provider}`, provider, `local:oauth:${provider}`, user.id]);
}
const accountSnapshot = db.query("SELECT id, accountId, providerId, userId, password, accessToken, refreshToken FROM account ORDER BY id").all();
await runMigrations(db);
await runMigrations(db);

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "upgrade-test", alg: "RS256", use: "sig" };
const codes = new Map<string, { nonce: string; challenge: string; subject: string; email: string; audience?: string; issuer?: string }>();
const provider = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/openid-configuration") return Response.json({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/authorize`,
      token_endpoint: `${url.origin}/token`,
      jwks_uri: `${url.origin}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    });
    if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
    if (url.pathname !== "/token") return new Response("Not Found", { status: 404 });
    const body = new URLSearchParams(await request.text());
    const code = body.get("code")!;
    const login = codes.get(code);
    codes.delete(code);
    if (!login || createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") !== login.challenge) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const idToken = await new SignJWT({ nonce: login.nonce, email: login.email, email_verified: true, name: "Existing SSO User" })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(login.issuer ?? url.origin).setAudience(login.audience ?? "upgrade-client")
      .setSubject(login.subject).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    return Response.json({ access_token: "new-access-token", refresh_token: "new-refresh-token", token_type: "Bearer", expires_in: 300, id_token: idToken });
  },
});
const { createSsoProvider } = await import("../services/sso-providers.service");
for (const slug of ["authentik", "authentik-alias"]) createSsoProvider({
  name: slug, slug, enabled: true, issuer_url: provider.url.origin,
  client_id: "upgrade-client", client_secret: "synthetic-provider-secret",
  redirect_origin: "http://localhost:7860",
});

const { auth, allowCreation, CREATION_NONCE_HEADER } = await import("./index");
const { default: app } = await import("../app");
afterAll(() => {
  provider.stop(true);
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

const origin = "http://localhost:7860";
async function request(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("host", "localhost:7860");
  headers.set("origin", origin);
  return app.request(`${origin}${path}`, { ...init, headers });
}
async function ssoLogin(providerId = "authentik", overrides: Partial<NonNullable<ReturnType<typeof codes.get>>> = {}, linkCookie?: string) {
  const start = await request(linkCookie ? "/api/auth/link-social" : "/api/auth/sign-in/social", {
    method: "POST", headers: { "content-type": "application/json", ...(linkCookie ? { cookie: linkCookie } : {}) },
    body: JSON.stringify({ provider: providerId, callbackURL: `${origin}/sso-complete`, errorCallbackURL: `${origin}/sso-error` }),
  });
  expect(start.status).toBe(200);
  const authorization = new URL((await start.json()).url);
  // The IdP registration does not need to change during the upgrade.
  expect(authorization.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/oauth2/callback/${providerId}`);
  expect(authorization.searchParams.get("nonce")).toBeTruthy();
  const code = crypto.randomUUID();
  codes.set(code, {
    nonce: authorization.searchParams.get("nonce")!, challenge: authorization.searchParams.get("code_challenge")!,
    subject: "shared-subject", email: providerId === "authentik" ? owner.email : aliasUser.email, ...overrides,
  });
  const cookie = [...start.headers.getSetCookie().map((value) => value.split(";", 1)[0]), ...(linkCookie ? [linkCookie] : [])].join("; ");
  return request(`/api/auth/oauth2/callback/${providerId}?${new URLSearchParams({ code, state: authorization.searchParams.get("state")! })}`, { headers: { cookie } });
}

describe("Better Auth upgrade continuity", () => {
  test("retains accounts, password hashes, and a cookie issued by Better Auth 1.7.2", async () => {
    expect(db.query("SELECT id, accountId, providerId, userId, password, accessToken, refreshToken FROM account ORDER BY id").all()).toEqual(accountSnapshot);
    const session = await request("/api/auth/get-session", { headers: { cookie: legacy.cookie } });
    expect(session.status).toBe(200);
    expect((await session.json()).user.id).toBe(owner.id);
    const protectedRoute = await request("/api/v1/personas", { headers: { cookie: legacy.cookie } });
    expect(protectedRoute.status).toBe(200);
    const login = await request("/api/auth/sign-in/username", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: owner.username, password: legacy.password }),
    });
    expect(login.status).toBe(200);
    expect((await login.json()).user.id).toBe(owner.id);
    expect(db.query("SELECT password FROM account WHERE providerId = 'credential'").get()).toEqual({ password: legacy.accounts[0]!.password });
  });

  test("preserves both SSO links when configured aliases share the same issuer and subject", async () => {
    for (const [providerId, expectedId] of [["authentik", owner.id], ["authentik-alias", aliasUser.id]]) {
      const callback = await ssoLogin(providerId);
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(`${origin}/sso-complete`);
      const cookie = callback.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
      const session = await request("/api/auth/get-session", { headers: { cookie } });
      expect((await session.json()).user.id).toBe(expectedId);
      expect(db.query("SELECT userId, accessToken, refreshToken FROM account WHERE providerId = ?").get(providerId!)).toEqual({
        userId: expectedId, accessToken: "new-access-token", refreshToken: "new-refresh-token",
      });
    }
    expect(db.query("SELECT COUNT(*) AS count FROM account").get()).toEqual({ count: 3 });
  });

  test("refuses an unlinked subject even when its verified email matches an existing account", async () => {
    const callback = await ssoLogin("authentik", { subject: "unlinked-subject" });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("/sso-error?error=");
    expect(callback.headers.getSetCookie().some((cookie) => cookie.startsWith("better-auth.session_token="))).toBe(false);
    expect(db.query("SELECT COUNT(*) AS count FROM account").get()).toEqual({ count: 3 });
    expect(db.query('SELECT COUNT(*) AS count FROM "user"').get()).toEqual({ count: 2 });
  });

  test("rejects signed ID tokens with the wrong audience, issuer, or nonce", async () => {
    for (const overrides of [{ audience: "another-client" }, { issuer: "https://another-provider.example.test" }, { nonce: "wrong-nonce" }]) {
      const callback = await ssoLogin("authentik", overrides);
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toContain("error=");
      expect(callback.headers.getSetCookie().some((cookie) => cookie.startsWith("better-auth.session_token="))).toBe(false);
    }
  });

  test("keeps signup closed while allowing explicitly approved account creation without an issuer field", async () => {
    const body = JSON.stringify({ name: "New User", username: "newuser", email: "new-user@example.test", password: "new-user-test-password" });
    const signup = (nonce?: string) => auth.handler(new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST", body,
      headers: { "content-type": "application/json", ...(nonce ? { [CREATION_NONCE_HEADER]: nonce } : {}) },
    }));
    expect((await signup()).status).toBeGreaterThanOrEqual(400);
    const response = await signup(allowCreation());
    expect(response.status).toBe(200);
    const id = (await response.json()).user.id;
    expect(db.query("SELECT accountId, userId FROM account WHERE userId = ? AND providerId = 'credential'").get(id))
      .toEqual({ accountId: id, userId: id });
    expect(await auth.$context).toBeTruthy();
  });

  test("can explicitly link a new SSO identity and then sign in through it", async () => {
    const signup = await auth.handler(new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST", headers: { "content-type": "application/json", [CREATION_NONCE_HEADER]: allowCreation() },
      body: JSON.stringify({ name: "Link User", username: "linkuser", email: "link-user@example.test", password: "synthetic-link-user-password" }),
    }));
    expect(signup.status).toBe(200);
    const userId = (await signup.json()).user.id;
    const cookie = signup.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const identity = { subject: "newly-linked-subject", email: "different-idp-email@example.test" };
    const linked = await ssoLogin("authentik", identity, cookie);
    expect(linked.headers.get("location")).toBe(`${origin}/sso-complete`);
    expect(db.query("SELECT userId FROM account WHERE providerId = 'authentik' AND accountId = ?").get(identity.subject)).toEqual({ userId });
    const callback = await ssoLogin("authentik", identity);
    expect(callback.headers.get("location")).toBe(`${origin}/sso-complete`);
    const session = await request("/api/auth/get-session", {
      headers: { cookie: callback.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ") },
    });
    expect((await session.json()).user.id).toBe(userId);
  });
});
