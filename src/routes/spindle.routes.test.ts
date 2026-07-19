import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SpindleHostDescriptorV1 } from "lumiverse-spindle-types";
import {
  SPINDLE_COMPATIBILITY_ERROR_CODE,
} from "lumiverse-spindle-types";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import {
  digestSpindleHostDescriptor,
  getBackendLumiverseVersion,
  parseCanonicalSemver,
} from "../spindle/host-compatibility";

// Keep the production auth middleware importable without constructing a real
// BetterAuth instance; the handshake itself uses the authenticated session
// context installed by the test app below.
mock.module("../auth/index", () => ({ auth: { api: {} } }));

const { spindleRoutes } = await import("./spindle.routes");

const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const IDENTIFIER = "compat_route_test";
const USER_ID = "visible-user";
const NONCE = "0123456789abcdefghijkl";

let testDataDir = "";
const originalDataDir = env.dataDir;

function createSchema(): void {
  getDb().run(`
    CREATE TABLE extensions (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      author TEXT NOT NULL,
      description TEXT DEFAULT '',
      github TEXT NOT NULL,
      homepage TEXT DEFAULT '',
      permissions TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      installed_at INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT 1,
      metadata TEXT DEFAULT '{}',
      install_scope TEXT NOT NULL DEFAULT 'operator',
      installed_by_user_id TEXT,
      branch TEXT DEFAULT NULL
    )
  `);
  getDb().run(`
    CREATE TABLE extension_grants (
      id TEXT PRIMARY KEY,
      extension_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      granted_at INTEGER NOT NULL DEFAULT 1,
      UNIQUE(extension_id, permission)
    )
  `);
}

function writeManifest(minimum?: string): void {
  const repo = join(testDataDir, "extensions", IDENTIFIER, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, "spindle.json"),
    JSON.stringify({
      identifier: IDENTIFIER,
      name: "Compatibility route test",
      version: "1.0.0",
      author: "Tester",
      github: "https://github.com/example/compat-route-test",
      homepage: "https://example.test/compat-route-test",
      permissions: [],
      ...(minimum === undefined ? {} : { minimum_lumiverse_version: minimum }),
    }),
  );
}

function insertExtension(): void {
  getDb().run(
    `INSERT INTO extensions (
      id, identifier, name, version, author, description, github, homepage,
      permissions, enabled, installed_at, updated_at, metadata, install_scope,
      installed_by_user_id, branch
    ) VALUES (?, ?, ?, ?, ?, '', ?, ?, '[]', 1, 1, 1, '{}', 'operator', NULL, NULL)`,
    [
      INSTALLATION_ID,
      IDENTIFIER,
      "Compatibility route test",
      "1.0.0",
      "Tester",
      "https://github.com/example/compat-route-test",
      "https://example.test/compat-route-test",
    ],
  );
}

function appForVisibleUser(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("session", {
      user: {
        id: USER_ID,
        name: "Visible user",
        email: "visible@example.test",
        role: "user",
      },
      session: {
        id: "visible-session",
        userId: USER_ID,
        token: "visible-token",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    c.set("userId", USER_ID);
    return next();
  });
  app.route("/", spindleRoutes);
  return app;
}

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  createSchema();
  testDataDir = mkdtempSync(join(tmpdir(), "lumiverse-spindle-route-"));
  env.dataDir = testDataDir;
  writeManifest();
  insertExtension();
});

afterEach(() => {
  closeDatabase();
  env.dataDir = originalDataDir;
  if (testDataDir) rmSync(testDataDir, { recursive: true, force: true });
  testDataDir = "";
});

describe("Spindle compatibility handshake route", () => {
  test("returns the authenticated user's visible descriptor and canonical digest", async () => {
    const response = await appForVisibleUser().request(`/${INSTALLATION_ID}/compatibility-handshake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: NONCE }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      nonce: string;
      descriptor: SpindleHostDescriptorV1;
      digest: string;
    };
    expect(body.nonce).toBe(NONCE);
    expect(body.descriptor.extensionInstallationId).toBe(INSTALLATION_ID);
    expect(body.descriptor.descriptorVersion).toBe(1);
    expect(body.digest).toBe(await digestSpindleHostDescriptor(body.descriptor));
  });

  test("rejects malformed or extra nonce fields with the typed compatibility code", async () => {
    const response = await appForVisibleUser().request(`/${INSTALLATION_ID}/compatibility-handshake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: "not-valid", extra: true }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Request body must contain only a 22-86 character base64url nonce",
      code: SPINDLE_COMPATIBILITY_ERROR_CODE,
    });
  });

  test("returns not found for an extension outside the visible set", async () => {
    const response = await appForVisibleUser().request(
      "/00000000-0000-4000-8000-000000000000/compatibility-handshake",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: NONCE }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  test("returns a typed compatibility failure for an incompatible manifest", async () => {
    const hostVersion = parseCanonicalSemver(await getBackendLumiverseVersion(), "Lumiverse version");
    const requiredVersion = `${BigInt(hostVersion.major) + 1n}.0.0`;
    writeManifest(requiredVersion);
    const response = await appForVisibleUser().request(`/${INSTALLATION_ID}/compatibility-handshake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: NONCE }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; code: string };
    expect(body.code).toBe(SPINDLE_COMPATIBILITY_ERROR_CODE);
    expect(body.error).toContain(`requires Lumiverse ${requiredVersion} or newer`);
  });
});
