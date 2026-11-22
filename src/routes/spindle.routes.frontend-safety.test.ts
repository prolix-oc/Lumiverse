import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";

mock.module("../auth/middleware", () => ({ requireOwner: async (_c: unknown, next: () => Promise<void>) => next() }));

const { spindleRoutes } = await import("./spindle.routes");
const lifecycle = await import("../spindle/lifecycle");
const { eventBus } = await import("../ws/bus");
const { EventType } = await import("../ws/events");

const originalDataDir = env.dataDir;
const identifier = "frontend_safety_probe";
const extensionId = "frontend-safety-probe";
const unsafeSource = `export const id = crypto.${"randomUUID"}();`;
let directory: string;
let repo: string;
let app: Hono;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "spindle-frontend-safety-"));
  env.dataDir = directory;
  repo = join(directory, "extensions", identifier, "repo");
  mkdirSync(join(repo, "dist"), { recursive: true });
  writeFileSync(join(repo, "spindle.json"), JSON.stringify({
    identifier, name: "Frontend safety probe", version: "1.0.0", author: "Test",
    github: "https://github.com/example/frontend-safety-probe",
    entry_frontend: "dist/frontend.js", entry_frontend_widget: "dist/widget.js",
  }));
  writeFileSync(join(repo, "dist/frontend.js"), "export function setup(ctx) { return ctx.uuid.v4(); }");
  writeFileSync(join(repo, "dist/widget.js"), "export function setupWidget(ctx) { return ctx.uuid.v7(); }");
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  getDb().query("INSERT INTO extensions (id, identifier, name, version, author, github) VALUES (?, ?, ?, ?, ?, ?)")
    .run(extensionId, identifier, "Frontend safety probe", "1.0.0", "Test", "https://github.com/example/frontend-safety-probe");
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("session", { user: { id: "owner", role: "owner" } } as never);
    await next();
  });
  app.route("/spindle", spindleRoutes);
});

afterEach(async () => {
  await lifecycle.stopAllExtensions();
  closeDatabase();
  env.dataDir = originalDataDir;
  rmSync(directory, { recursive: true, force: true });
});

describe("frontend bundle UUID policy", () => {
  for (const [route, entry] of [["frontend", "frontend.js"], ["frontend/widget", "widget.js"]]) {
    test(`rejects ${route} before serving JavaScript or returning a cached 304`, async () => {
      const url = `/spindle/${extensionId}/${route}`;
      const allowed = await app.request(url);
      expect(allowed.status).toBe(200);
      const etag = allowed.headers.get("etag")!;
      expect((await app.request(url, { headers: { "if-none-match": etag } })).status).toBe(304);

      writeFileSync(join(repo, "dist", entry), unsafeSource);
      const response = await app.request(url, { headers: { "if-none-match": "*" } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining(`Extension "${identifier}" uses blocked frontend capabilities:`),
      });
      expect((await app.request(`/spindle/${extensionId}/manifest`)).status).toBe(400);

      // Presence reporting must still list the extension for repair/removal.
      const listed = await app.request("/spindle");
      expect(listed.status).toBe(200);
      expect((await listed.json() as any).extensions[0].has_frontend).toBe(true);
    });

    test(`blocks startup and emits the existing extension-error event for ${entry}`, async () => {
      writeFileSync(join(repo, "dist", entry), unsafeSource);
      const errorEvent = new Promise<any>((resolve) => {
        const unsubscribe = eventBus.on(EventType.SPINDLE_EXTENSION_ERROR, (event) => {
          unsubscribe();
          resolve(event.payload);
        });
      });
      await expect(lifecycle.startExtension(extensionId)).rejects.toThrow("blocked frontend capabilities");
      expect(lifecycle.isRunning(extensionId)).toBe(false);
      expect(await errorEvent).toMatchObject({
        extensionId,
        error: expect.stringContaining("ctx.uuid.v4() or ctx.uuid.v7()"),
      });
    });
  }
});
