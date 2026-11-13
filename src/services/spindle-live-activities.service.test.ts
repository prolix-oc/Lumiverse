import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Hono } from "hono";

const db = new Database(":memory:");
db.exec(`PRAGMA foreign_keys = ON; CREATE TABLE user (id TEXT PRIMARY KEY);
  CREATE TABLE extensions (id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, install_scope TEXT DEFAULT 'operator', installed_by_user_id TEXT);
  CREATE TABLE extension_grants (extension_id TEXT, permission TEXT, scope TEXT);
  CREATE TABLE chats (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('owner'), ('other');
  INSERT INTO extensions(id) VALUES ('extension'), ('foreign');
  INSERT INTO extension_grants VALUES ('extension', 'push_notification', 'system'), ('foreign', 'push_notification', 'system');`);
for (const migration of ["127_ios_push_destinations.sql", "128_ios_live_activities.sql", "131_ios_notification_delivery.sql", "136_spindle_live_activities.sql"])
  db.exec(await Bun.file(new URL(`../db/migrations/${migration}`, import.meta.url)).text());
mock.module("../db/connection", () => ({ getDb: () => db }));
mock.module("../crypto/init", () => ({ getEncryptionKeyBytes: () => new Uint8Array(32).fill(13) }));
const directory = await mkdtemp(join(tmpdir(), "spindle-activity-"));
const image = join(directory, "preview.png");
await sharp({ create: { width: 200, height: 100, channels: 3, background: "#aa77cc" } }).png().toFile(image);
mock.module("./images.service", () => ({ getImageFilePath: async (user: string, id: string) => user === "owner" && id === "owned-image" ? image : null }));
let response: { sent: boolean; invalidToken?: boolean } = { sent: true };
let respond: (() => Promise<{ sent: boolean; invalidToken?: boolean }>) | undefined;
const deliveries: { destination: any; state: any; timestamp: number; terminal: boolean }[] = [];
mock.module("./apns.service", () => ({ getLiveActivityAPNsInfo: () => ({ configured: true }),
  sendAPNsSpindleActivity: async (destination: any, state: any, timestamp: number, terminal: boolean) => {
    deliveries.push({ destination, state, timestamp, terminal }); return respond ? respond() : response;
  } }));
const service = await import("./spindle-live-activities.service");
const { sealIOSNotificationSecret } = await import("./apns-encryption");
const { spindleLiveActivityRoutes, spindleLiveActivityTransportRoutes } = await import("../routes/spindle-live-activities.routes");
const app = new Hono().route("/native", spindleLiveActivityTransportRoutes);
app.use("/browser/*", async (c, next) => { c.set("userId", c.req.header("X-User") || "owner"); await next(); });
app.route("/browser", spindleLiveActivityRoutes);
const key = Buffer.alloc(32, 41), keyId = createHash("sha256").update(key).digest("hex").slice(0, 32);
const installation = { deviceId: "installation-123456789", bundleId: "chat.lumiverse.ios", environment: "development", serverOrigin: "https://example.com", registrationIds: [] as string[] };
function decode(state: any, registrationId: string) {
  const e = state.encrypted;
  const row = db.query("SELECT credential_hash FROM spindle_live_activity_devices WHERE id=?").get(registrationId) as { credential_hash: string };
  const activityKey = createHmac("sha256", Buffer.from(row.credential_hash, "hex"))
    .update(`lumiverse-spindle-activity:v1:${registrationId}`).digest();
  expect(e.keyId).toBe(createHash("sha256").update(activityKey).digest("hex").slice(0, 32));
  const decipher = createDecipheriv("aes-256-gcm", activityKey, Buffer.from(e.nonce, "base64"));
  decipher.setAAD(Buffer.from(`lumiverse-apns:v1:chat.lumiverse.ios:development:${e.keyId}`));
  decipher.setAuthTag(Buffer.from(e.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.ciphertext, "base64")), decipher.final()]).toString());
}
beforeEach(async () => {
  await service.flushSpindleLiveActivities();
  db.exec("DELETE FROM spindle_live_activities; DELETE FROM spindle_live_activity_clients; DELETE FROM ios_push_destinations; UPDATE extensions SET enabled = 1;");
  db.exec("DELETE FROM extension_grants; INSERT INTO extension_grants VALUES ('extension', 'push_notification', 'system'), ('foreign', 'push_notification', 'system');");
  db.query(`INSERT INTO ios_push_destinations (id, user_id, device_id, device_token, bundle_id, environment, server_origin, registered_at, encryption_key, encryption_key_id)
    VALUES ('destination', 'owner', ?, ?, ?, ?, ?, 1, ?, ?)`).run(installation.deviceId, "ab".repeat(32), installation.bundleId,
      installation.environment, installation.serverOrigin, sealIOSNotificationSecret(key.toString("base64"), "ios-key:destination"), keyId);
  service.spindleLiveActivitySnapshot("owner", installation);
  response = { sent: true }; respond = undefined; deliveries.length = 0;
});
afterAll(async () => { await service.flushSpindleLiveActivities(); db.close(); await rm(directory, { recursive: true, force: true }); mock.restore(); });
const start = (extra: object = {}) => service.startSpindleLiveActivity("extension", "Example Extension", "owner",
  { key: "job", layout: "status", title: "Private task", body: "Private details", ...extra } as any);
function enroll() {
  const item = service.spindleLiveActivitySnapshot("owner", installation).items[0]!;
  expect(service.refreshSpindleLiveActivity(item.registrationId, item.credential!, { activityId: "native-activity", pushToken: "cd".repeat(32) })).toBe(true);
  return item;
}

test("queues an idempotent task, encrypts the presentation and enrolls only the matching device/account", async () => {
  expect(service.spindleLiveActivityStatus("owner")).toEqual({ available: true, layouts: ["status", "progress", "image"], remoteStart: false, enrolledDevices: 1 });
  const results = await Promise.all(Array.from({ length: 4 }, () => start()));
  expect(new Set(results.map(r => r.id)).size).toBe(1);
  expect(results[0]!.state).toBe("queued");
  const item = enroll(); await service.flushSpindleLiveActivities();
  expect(JSON.stringify(item.state)).not.toContain("Private");
  expect(decode(item.state, item.registrationId)).toMatchObject({ title: "Private task", body: "Private details", layout: "status", terminal: false });
  expect(deliveries).toHaveLength(1);
  expect(() => service.spindleLiveActivitySnapshot("other", installation)).toThrow();
  expect(service.refreshSpindleLiveActivity(item.registrationId, "x".repeat(43), { activityId: "native-activity", pushToken: "de".repeat(32) })).toBe(false);
  expect(service.spindleLiveActivitySnapshot("owner", { ...installation, registrationIds: [item.registrationId] }).items[0]?.credential).toBeUndefined();
  expect((await start()).state).toBe("active");
});

test("validates layouts, progress, duration and image ownership before persisting", async () => {
  for (const invalid of [{ layout: "custom" }, { layout: "progress", progress: -1 }, { layout: "progress", progress: Infinity },
    { layout: "image", imageId: "foreign-image" }, { durationSeconds: 28801 }, { title: "<script>hidden</script>" }])
    await expect(start(invalid)).rejects.toThrow();
  expect(db.query("SELECT COUNT(*) AS count FROM spindle_live_activities").get()).toEqual({ count: 0 });
});

test("renders all three templates using complete bounded encrypted snapshots", async () => {
  for (const presentation of [{ layout: "status", title: "Status" }, { layout: "progress", title: "Progress", progress: 0.75 },
    { layout: "image", title: "Preview", imageId: "owned-image" }]) {
    await start({ ...presentation, key: presentation.layout });
  }
  const items = service.spindleLiveActivitySnapshot("owner", installation).items;
  expect(items).toHaveLength(3);
  for (const item of items) {
    const clear = decode(item.state, item.registrationId);
    expect(Buffer.byteLength(JSON.stringify({ ...item.attributes, renderKey: "x".repeat(44) })) + Buffer.byteLength(JSON.stringify(item.state))).toBeLessThanOrEqual(3800);
    if (clear.layout === "progress") expect(clear.progress).toBe(0.75);
    if (clear.layout === "image") {
      expect(Buffer.from(clear.imageBase64, "base64").length).toBeLessThanOrEqual(700);
      expect((await sharp(Buffer.from(clear.imageBase64, "base64")).metadata()).format).toBe("jpeg");
    }
  }
});

test("updates and ends only owned tasks, preserves a final snapshot, and never reopens an ended key", async () => {
  const task = await start();
  await expect(service.updateSpindleLiveActivity("foreign", "owner", task.id, { layout: "status", title: "Spoof" })).rejects.toThrow("not found");
  expect(() => service.endSpindleLiveActivity("extension", "other", task.id)).toThrow("not found");
  expect((await service.updateSpindleLiveActivity("extension", "owner", task.id, { layout: "progress", title: "Rendering", progress: 0.5 })).revision).toBe(2);
  expect(service.endSpindleLiveActivity("extension", "owner", task.id).state).toBe("ended");
  expect((await start()).state).toBe("ended");
  await expect(service.updateSpindleLiveActivity("extension", "owner", task.id, { layout: "status", title: "Restart" })).rejects.toThrow("ended");
});

test("dismissal and destination removal revoke delivery and capability", async () => {
  await start(); const item = enroll(); await service.flushSpindleLiveActivities();
  service.dismissSpindleLiveActivity(item.registrationId, item.credential!);
  expect(service.spindleLiveActivitySnapshot("owner", installation).items).toEqual([]);
  db.exec("DELETE FROM ios_push_destinations;");
  expect(service.spindleLiveActivityStatus("owner").available).toBe(false);
  expect(service.refreshSpindleLiveActivity(item.registrationId, item.credential!, {})).toBe(false);
});

test("disabled extensions and revoked grants terminate persisted tasks", async () => {
  const task = await start();
  db.exec("UPDATE extensions SET enabled = 0 WHERE id = 'extension'");
  await service.flushSpindleLiveActivities();
  expect((await start()).state).toBe("ended");
  expect((db.query("SELECT ended_at FROM spindle_live_activities WHERE id = ?").get(task.id) as any).ended_at).toBeGreaterThan(0);
  db.exec("UPDATE extensions SET enabled = 1;");
  const other = await start({ key: "another" }); db.exec("DELETE FROM extension_grants WHERE extension_id = 'extension'");
  await service.flushSpindleLiveActivities();
  expect((db.query("SELECT ended_at FROM spindle_live_activities WHERE id = ?").get(other.id) as any).ended_at).toBeGreaterThan(0);
});

test("native transport rejects credentials that belong to another enrollment", async () => {
  await start(); const item = service.spindleLiveActivitySnapshot("owner", installation).items[0]!;
  const result = await app.request("/native/" + item.registrationId, { method: "PUT", headers: { Authorization: "Bearer " + "x".repeat(43), "Content-Type": "application/json" },
    body: JSON.stringify({ activityId: "native", pushToken: "ab".repeat(32) }) });
  expect(result.status).toBe(401);
  const response = await app.request("/browser/snapshot", { method: "POST", headers: { "X-User": "other", "Content-Type": "application/json" }, body: JSON.stringify(installation) });
  expect(response.status).toBe(400);
});

test("in-flight invalidation cannot revoke a rotated native token", async () => {
  await start();
  let release!: (value: { sent: boolean; invalidToken: boolean }) => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  respond = () => new Promise(resolve => { release = resolve; entered(); });
  const item = enroll(); await waiting;
  service.refreshSpindleLiveActivity(item.registrationId, item.credential!, { activityId: "native-activity", pushToken: "ef".repeat(32) });
  release({ sent: false, invalidToken: true }); await service.flushSpindleLiveActivities();
  expect(db.query("SELECT push_token, dismissed FROM spindle_live_activity_devices WHERE id = ?").get(item.registrationId))
    .toEqual({ push_token: "ef".repeat(32), dismissed: 0 });
  respond = undefined; await service.flushSpindleLiveActivities();
  expect(deliveries.at(-1)?.destination.device_token).toBe("ef".repeat(32));
});

test("repeated token enrollment preserves provider backoff and retry catches up to the latest revision", async () => {
  const task = await start(); response = { sent: false };
  const item = enroll(); await service.flushSpindleLiveActivities();
  const before = db.query("SELECT token_epoch, next_attempt_at FROM spindle_live_activity_devices WHERE id = ?").get(item.registrationId);
  service.refreshSpindleLiveActivity(item.registrationId, item.credential!, { activityId: "native-activity", pushToken: "cd".repeat(32) });
  expect(db.query("SELECT token_epoch, next_attempt_at FROM spindle_live_activity_devices WHERE id = ?").get(item.registrationId)).toEqual(before);
  await service.updateSpindleLiveActivity("extension", "owner", task.id, { layout: "progress", title: "Latest state", progress: 0.9 });
  await service.flushSpindleLiveActivities();
  response = { sent: true }; db.exec("UPDATE spindle_live_activity_devices SET next_attempt_at = 0;");
  await service.flushSpindleLiveActivities();
  expect(decode(deliveries.at(-1)!.state, item.registrationId)).toMatchObject({ title: "Latest state", progress: 0.9, revision: 2 });
});

test("rendering keys are registration-scoped, stay outside network attributes, and survive notification-key rotation", async () => {
  await start(); const item = enroll(); await service.flushSpindleLiveActivities();
  expect(item.attributes).not.toHaveProperty("renderKey");
  expect(item.state.encrypted.keyId).not.toBe(keyId);
  await start({ key: "other-task" });
  const items = service.spindleLiveActivitySnapshot("owner", { ...installation, registrationIds: [item.registrationId] }).items;
  expect(new Set(items.map(i => i.state.encrypted.keyId)).size).toBe(2);
  const changedKey = Buffer.alloc(32, 77);
  db.query("UPDATE ios_push_destinations SET encryption_key=?, encryption_key_id=?")
    .run(sealIOSNotificationSecret(changedKey.toString("base64"), "ios-key:destination"), createHash("sha256").update(changedKey).digest("hex").slice(0, 32));
  const rotated = service.spindleLiveActivitySnapshot("owner", { ...installation, registrationIds: [item.registrationId] }).items.find(i => i.registrationId === item.registrationId)!;
  expect(rotated.state.encrypted.keyId).toBe(item.state.encrypted.keyId);
  expect(decode(rotated.state, item.registrationId)).toMatchObject({ title: "Private task" });
});
