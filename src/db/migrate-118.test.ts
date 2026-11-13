import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const MIGRATION_PATH = `${import.meta.dir}/migrations/118_desktop_oauth_provider.sql`;

describe("118 desktop OAuth provider", () => {
  test("installs a public native PKCE client and its token schema", async () => {
    const db = new Database(":memory:");
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.run(`
        CREATE TABLE "user" (id TEXT PRIMARY KEY);
        CREATE TABLE "session" (id TEXT PRIMARY KEY);
      `);
      db.run(await Bun.file(MIGRATION_PATH).text());

      expect(db.query(`
        SELECT clientId, clientSecret, skipConsent, tokenEndpointAuthMethod,
               applicationType, redirectUris, requirePKCE
        FROM "oauthClient" WHERE clientId = 'lumiverse-desktop'
      `).get()).toEqual({
        clientId: "lumiverse-desktop",
        clientSecret: null,
        skipConsent: 1,
        tokenEndpointAuthMethod: "none",
        applicationType: "native",
        redirectUris: '["http://127.0.0.1/callback"]',
        requirePKCE: 1,
      });
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jwks'").get())
        .toEqual({ name: "jwks" });
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauthRefreshToken'").get())
        .toEqual({ name: "oauthRefreshToken" });
    } finally {
      db.close();
    }
  });
});
