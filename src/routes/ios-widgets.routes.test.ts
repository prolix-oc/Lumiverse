import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const imagesDirectory = await mkdtemp(join(tmpdir(), "widget-portraits-"));
const imageFile = join(imagesDirectory, "portrait.png");
await sharp({ create: { width: 300, height: 400, channels: 3, background: "#9977dd" } }).png().toFile(imageFile);
mock.module("../services/characters.service", () => ({ getCharacterAvatarInfo: (user: string, id: string) =>
  user === "owner" && id === "portrait" ? { image_id: "full-image", avatar_crop_image_id: "square-crop", avatar_path: null } : null }));
mock.module("../services/images.service", () => ({ getImageFilePath: async (_user: string, image: string) => image === "full-image" ? imageFile : null }));
mock.module("../services/files.service", () => ({ getAvatarPath: async () => null }));

const db = new Database(":memory:");
db.exec(`PRAGMA foreign_keys = ON;
 CREATE TABLE user (id TEXT PRIMARY KEY, banned INTEGER DEFAULT 0);
 INSERT INTO user(id) VALUES ('owner'), ('other');
 CREATE TABLE characters (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, updated_at INTEGER);
 CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT, character_id TEXT, metadata TEXT, updated_at INTEGER);
 CREATE TABLE settings (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY(user_id, key));`);
db.exec(await Bun.file(new URL("../db/migrations/132_ios_widgets.sql", import.meta.url)).text());
mock.module("../db/connection", () => ({ getDb: () => db }));
const { iosWidgetRoutes, iosWidgetTransportRoutes } = await import("./ios-widgets.routes");
const { widgetSnapshot } = await import("../services/ios-widgets.service");
const app = new Hono().route("/native", iosWidgetTransportRoutes);
app.use("/browser/*", async (c, next) => { c.set("userId", c.req.header("X-Test-User") || "owner"); await next(); });
app.route("/browser", iosWidgetRoutes);
function setting(user: string, key: string, value: unknown) { db.query("INSERT OR REPLACE INTO settings VALUES (?, ?, ?)").run(user, key, JSON.stringify(value)); }
function character(id: string, user = "owner") { db.query("INSERT INTO characters VALUES (?, ?, ?, 10)").run(id, user, `<b>${id}</b>`); }
function chat(id: string, characterId: string, updated = 10, metadata: unknown = {}, user = "owner") {
  db.query("INSERT INTO chats VALUES (?, ?, ?, ?, ?)").run(id, user, characterId, typeof metadata === "string" ? metadata : JSON.stringify(metadata), updated);
}
async function enroll(user = "owner", deviceId = "installation-12345678") {
  const response = await app.request("/browser/registrations", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": user }, body: JSON.stringify({ deviceId }) });
  expect(response.status).toBe(201);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response.json() as Promise<{ registrationId: string; credential: string }>;
}
const snapshot = (id: string, token?: string) => app.request(`/native/registrations/${id}/snapshot`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
beforeEach(() => { db.exec("DELETE FROM ios_widget_registrations; DELETE FROM settings; DELETE FROM chats; DELETE FROM characters; UPDATE user SET banned = 0;"); });
afterAll(async () => { db.close(); mock.restore(); await rm(imagesDirectory, { recursive: true, force: true }); });

test("recent selection filters before the limit, deduplicates, and never exposes another user's character", () => {
  for (let i = 0; i < 22; i++) { character(`c${i}`); chat(`chat${i}`, `c${i}`, 100 - i); }
  chat("newest", "c5", 110); chat("duplicate", "c5", 105);
  chat("group", "c19", 200, { group: true }); chat("temp", "c20", 201, { temporary: true });
  chat("hidden", "c21", 202, { hidden_from_recent: true });
  character("private", "other"); chat("bad-owner", "private", 300); chat("deleted", "missing", 301);
  setting("owner", "landingHiddenCharacterIds", ["c0", "c1"]);
  setting("other", "landingHiddenCharacterIds", ["c2"]);
  setting("owner", "favorites", ["c10"]);
  const result = widgetSnapshot("owner");
  expect(result.recent.map(c => c.characterId)).toEqual(["c5", "c2", "c3", "c4", "c6", "c7", "c8", "c9", "c10", "c11", "c12", "c13", "c14", "c15", "c16", "c17"]);
  expect(result.recent[0]?.chatId).toBe("newest");
  expect(result.recent[0]?.name).toBe("c5");
});

test("favorites keeps saved order, includes no-chat and home-hidden characters, and ignores unreadable IDs", () => {
  for (const id of ["a", "b", "c"]) character(id);
  character("private", "other");
  chat("valid", "b", 10); chat("hidden", "b", 30, { hidden_from_recent: true }); chat("group", "a", 40, { group: 1 });
  setting("owner", "favorites", ["c", "private", "missing", "a", "b", "b"]);
  setting("owner", "landingHiddenCharacterIds", ["b"]);
  expect(widgetSnapshot("owner").favorites.map(c => [c.characterId, c.chatId])).toEqual([["c", null], ["a", null], ["b", "valid"]]);
  expect(widgetSnapshot("owner").recent).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS count FROM chats").get()).toEqual({ count: 3 });
});

test("malformed metadata and settings cannot abort a snapshot; favorites is bounded after unreadable entries", () => {
  character("a"); chat("a-chat", "a", 10, "{invalid");
  db.query("INSERT INTO settings VALUES ('owner', 'landingHiddenCharacterIds', 'not-json')").run();
  expect(widgetSnapshot("owner").recent[0]?.characterId).toBe("a");
  for (let i = 0; i < 20; i++) character(`f${i}`);
  setting("owner", "favorites", ["missing", null, 2, ...Array.from({ length: 20 }, (_, i) => `f${i}`)]);
  expect(widgetSnapshot("owner").favorites).toHaveLength(16);
});

test("credentials are hashed, scoped to an account, and replaced per installation", async () => {
  character("mine"); chat("mine-chat", "mine"); character("theirs", "other"); chat("other-chat", "theirs", 10, {}, "other");
  const first = await enroll();
  expect(JSON.stringify(db.query("SELECT * FROM ios_widget_registrations").all())).not.toContain(first.credential);
  expect((await snapshot(first.registrationId)).status).toBe(401);
  expect((await snapshot(first.registrationId, "x".repeat(43))).status).toBe(401);
  const response = await snapshot(first.registrationId, first.credential);
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect((await response.json()).recent.map((c: any) => c.characterId)).toEqual(["mine"]);
  const next = await enroll();
  expect((await snapshot(first.registrationId, first.credential)).status).toBe(401);
  expect((await snapshot(next.registrationId, next.credential)).status).toBe(200);
  expect((await app.request(`/native/registrations/${next.registrationId}/characters/theirs/portrait`, { headers: { Authorization: `Bearer ${next.credential}` } })).status).toBe(404);
});

test("revocation, expiry, bans, and user deletion invalidate native credentials", async () => {
  const first = await enroll();
  await app.request(`/browser/registrations/${first.registrationId}`, { method: "DELETE", headers: { "X-Test-User": "other" } });
  expect((await snapshot(first.registrationId, first.credential)).status).toBe(200);
  await app.request(`/native/registrations/${first.registrationId}`, { method: "DELETE", headers: { Authorization: `Bearer ${first.credential}` } });
  expect((await snapshot(first.registrationId, first.credential)).status).toBe(401);
  const second = await enroll(); db.query("UPDATE ios_widget_registrations SET expires_at = 1").run();
  expect((await snapshot(second.registrationId, second.credential)).status).toBe(401);
  const third = await enroll(); db.query("UPDATE user SET banned = 1 WHERE id = 'owner'").run();
  expect((await snapshot(third.registrationId, third.credential)).status).toBe(401);
  db.query("UPDATE user SET banned = 0 WHERE id = 'owner'").run();
  const fourth = await enroll("other"); db.query("DELETE FROM user WHERE id = 'other'").run();
  expect((await snapshot(fourth.registrationId, fourth.credential)).status).toBe(401);
  db.query("INSERT INTO user(id) VALUES ('other')").run();
});

test("enrollment rejects missing and malformed installation IDs", async () => {
  for (const deviceId of [null, "short", "../installation-invalid", "x".repeat(129)]) {
    expect((await app.request("/browser/registrations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId }) })).status).toBe(400);
  }
});

test("portrait reads return bounded JPEGs and lose access as soon as the character is hidden", async () => {
  character("portrait"); chat("portrait-chat", "portrait");
  const { registrationId, credential } = await enroll();
  const read = () => app.request(`/native/registrations/${registrationId}/characters/portrait/portrait`, { headers: { Authorization: `Bearer ${credential}` } });
  const response = await read();
  expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toBe("image/jpeg");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const metadata = await sharp(await response.arrayBuffer()).metadata();
  expect([metadata.width, metadata.height]).toEqual([192, 256]);
  setting("owner", "landingHiddenCharacterIds", ["portrait"]);
  expect((await read()).status).toBe(404);
  setting("owner", "favorites", ["portrait"]);
  expect((await read()).status).toBe(200);
});
