import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import type {} from "../auth/middleware";

mock.module("../auth/index", () => ({ auth: { api: {} } }));
const { memoryCortexRoutes } = await import("./memory-cortex.routes");
const cortex = await import("../services/memory-cortex");
const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
app.route("/", memoryCortexRoutes);
beforeEach(async () => {
  closeDatabase(); initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  db.query("INSERT INTO chats(id,user_id,name) VALUES('chat','owner','Chat'),('foreign','other','Private')").run();
});
afterEach(() => { mock.restore(); closeDatabase(); });

test("aggregated passive status preserves legacy snapshots and ownership", async () => {
  const response = await app.request("/chats/chat/status");
  expect(response.status).toBe(200);
  const status = await response.json();
  expect(status.activity).toMatchObject({ chatId: "chat", runs: [] });
  expect(status.ingestion).toMatchObject({ status: "idle", phase: "complete", chatId: "chat" });
  expect(status.rebuild.status).toBe("idle");
  const legacy = await (await app.request("/chats/chat/rebuild-status")).json();
  expect(status.rebuild).toEqual(legacy);
  expect((await app.request("/chats/foreign/status")).status).toBe(404);
  expect((await app.request("/chats/missing/status")).status).toBe(404);
});

test("one unavailable optional status does not hide the other sections", async () => {
  spyOn(cortex, "getIngestionStatus").mockImplementation(() => { throw new Error("unavailable"); });
  const response = await app.request("/chats/chat/status");
  expect(response.status).toBe(200);
  const status = await response.json();
  expect(status.ingestion).toBeNull();
  expect(status.rebuild.status).toBe("idle");
  expect(status.activity.chatId).toBe("chat");
});
