import { afterAll, beforeEach, expect, mock, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const avatarDirectory = await mkdtemp(join(tmpdir(), "activity-avatar-"));
const avatarFile = join(avatarDirectory, "avatar.png");
await sharp({ create: { width: 160, height: 240, channels: 3, background: "#aa88ee" } }).png().toFile(avatarFile);
mock.module("../services/characters.service", () => ({ getCharacterAvatarInfo: (user: string, character: string) =>
  user === "owner" && character === "owned" ? { avatar_crop_image_id: "crop", image_id: null, avatar_path: null } : null }));
mock.module("../services/images.service", () => ({ getImageFilePath: async (user: string, image: string) => user === "owner" && image === "crop" ? avatarFile : null }));
mock.module("../services/files.service", () => ({ getAvatarPath: async () => null }));

const db = new Database(":memory:");
db.exec(`PRAGMA foreign_keys = ON;
  CREATE TABLE user (id TEXT PRIMARY KEY);
  CREATE TABLE chats (id TEXT PRIMARY KEY);
  INSERT INTO user VALUES ('owner'), ('other');
  INSERT INTO chats VALUES ('chat-1'), ('chat-2');`);
db.exec(await Bun.file(new URL("../db/migrations/127_ios_push_destinations.sql", import.meta.url)).text());
db.exec(await Bun.file(new URL("../db/migrations/128_ios_live_activities.sql", import.meta.url)).text());
db.exec(await Bun.file(new URL("../db/migrations/129_ios_activity_stage_sounds.sql", import.meta.url)).text());
db.exec(await Bun.file(new URL("../db/migrations/131_ios_notification_delivery.sql", import.meta.url)).text());
mock.module("../crypto/init", () => ({ getEncryptionKeyBytes: () => new Uint8Array(32).fill(41) }));
mock.module("../db/connection", () => ({ getDb: () => db }));
let notificationPreferences: { enabled?: boolean; events?: { generation_ended?: boolean; generation_error?: boolean } } | undefined;
mock.module("../services/settings.service", () => ({ getSetting: () => ({ value: notificationPreferences }) }));
let configured = true;
const deliveries: { token: string; state: { phase: string; label: string }; terminal: boolean; timestamp: number; immediate: boolean; activityAlert: boolean }[] = [];
let respond: (() => Promise<{ sent: boolean; invalidatedAt?: number; invalidToken?: boolean }>) | undefined;
mock.module("../services/apns.service", () => ({
  getLiveActivityAPNsInfo: () => ({ configured, bundleId: "chat.lumiverse.ios", reason: configured ? null : "Provider key required" }),
  sendAPNsLiveActivity: async (dest: { device_token: string }, state: { phase: string; label: string }, timestamp: number, terminal: boolean, immediate: boolean, activityAlert: boolean) => {
    deliveries.push({ token: dest.device_token, state, timestamp, terminal, immediate, activityAlert });
    return respond ? respond() : { sent: true };
  },
}));
const pool = await import("../services/generation-pool.service");
const registry = await import("../services/generation/active-generation-registry");
const service = await import("../services/ios-live-activities.service");
const { iosLiveActivityRoutes, iosLiveActivityTransportRoutes } = await import("./ios-live-activities.routes");
const { eventBus } = await import("../ws/bus");
const { EventType } = await import("../ws/events");
const app = new Hono().route("/native", iosLiveActivityTransportRoutes);
app.use("/browser/*", async (c, next) => { c.set("userId", c.req.header("X-Test-User") || "owner"); await next(); });
app.route("/browser", iosLiveActivityRoutes);
const input = { generationId: "gen-1", deviceId: "installation-123456789", bundleId: "chat.lumiverse.ios", environment: "development", serverOrigin: "https://lumiverse.example" };
function request(path: string, method: string, body?: unknown, credential?: string, user?: string) {
  return app.request(path, { method, headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    ...(user ? { "X-Test-User": user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function prepare(generationId = "gen-1") {
  const result = await request("/browser/prepare", "POST", { ...input, generationId });
  expect(result.status).toBe(201);
  return result.json() as Promise<{ registrationId: string; credential: string; state: { phase: string } }>;
}
const tokenBody = (token = "ab".repeat(32)) => ({ activityId: "native-activity-1", pushToken: token });
beforeEach(async () => {
  await service.flushLiveActivities();
  db.exec("DELETE FROM ios_live_activities; DELETE FROM ios_push_destinations;");
  pool.clearAllPoolEntries();
  registry.stopAllGenerations();
  pool.createPoolEntry({ generationId: "gen-1", userId: "owner", chatId: "chat-1", generationType: "normal" as any,
    characterName: "<b>Lumi</b>", characterId: "owned", model: "private-model", connectionName: "private-provider" });
  pool.getPoolEntry("gen-1")!.content = "private message";
  pool.getPoolEntry("gen-1")!.reasoning = "private reasoning";
  configured = true;
  notificationPreferences = undefined;
  eventBus.removeSessionVisibility("owner", "another-device");
  respond = undefined;
  deliveries.length = 0;
});
afterAll(async () => { registry.stopAllGenerations(); registry.stopGenerationSweep(); pool.stopPoolSweep(); db.close(); await rm(avatarDirectory, { recursive: true, force: true }); mock.restore(); });

test("completion alerts sound once and respect notification preferences and foreground presence", async () => {
  const { registrationId: id, credential } = await prepare();
  // Enroll directly at completion to avoid the one-second ActivityKit ordering boundary.
  pool.completePool("gen-1", "message-1");
  service.refreshLiveActivity(id, credential, tokenBody());
  await service.flushLiveActivities();
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]?.activityAlert).toBe(true);
  expect(deliveries[0]?.terminal).toBe(false);
  await service.flushLiveActivities();
  expect(deliveries).toHaveLength(1);

  const clock = spyOn(Date, "now");
  const afterAlert = new Date().getTime();
  try {
    // The persisted delay survives another flush/restart and the final end
    // never repeats the sound, including when an APNs end needs a retry.
    clock.mockReturnValue(afterAlert + 9_000);
    await service.flushLiveActivities();
    expect(deliveries).toHaveLength(1);
    clock.mockReturnValue(afterAlert + 11_000);
    respond = async () => ({ sent: false });
    await service.flushLiveActivities();
    expect(deliveries.at(-1)).toMatchObject({ terminal: true, activityAlert: false, state: { phase: "completed" } });
    clock.mockReturnValue(afterAlert + 14_000);
    respond = undefined;
    await service.flushLiveActivities();
    expect(deliveries).toHaveLength(3);
    expect(deliveries.filter(item => item.activityAlert)).toHaveLength(1);
    expect((db.query("SELECT ended_at FROM ios_live_activities WHERE id = ?").get(id) as any).ended_at).not.toBeNull();
    await service.flushLiveActivities();
    expect(deliveries).toHaveLength(3);
  } finally { clock.mockRestore(); respond = undefined; }

  for (const [preferences, visible] of [[{ enabled: false }, false], [{ events: { generation_ended: false } }, false], [undefined, true]] as const) {
    db.exec("DELETE FROM ios_live_activities");
    deliveries.length = 0;
    notificationPreferences = preferences;
    eventBus.setUserVisibility("owner", "another-device", visible);
    const enrollment = await prepare();
    service.refreshLiveActivity(enrollment.registrationId, enrollment.credential, tokenBody());
    await service.flushLiveActivities();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.activityAlert).toBe(false);
  }
});

test("failed activities retain one failure alert and honor the error event opt-out", async () => {
  pool.errorPool("gen-1", "private provider error");
  for (const enabled of [true, false]) {
    db.exec("DELETE FROM ios_live_activities");
    deliveries.length = 0;
    notificationPreferences = { events: { generation_error: enabled } };
    const enrollment = await prepare();
    service.refreshLiveActivity(enrollment.registrationId, enrollment.credential, tokenBody());
    await service.flushLiveActivities();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.activityAlert).toBe(enabled);
    expect(JSON.stringify(deliveries)).not.toContain("private provider error");
  }
});

test("stage cues advance once, survive token rotation, and stay silent on heartbeats or regressions", async () => {
  const clock = spyOn(Date, "now");
  let now = new Date().getTime();
  clock.mockImplementation(() => now);
  try {
    const { registrationId: id, credential } = await prepare();
    service.refreshLiveActivity(id, credential, tokenBody());
    await service.flushLiveActivities();
    expect(deliveries.at(-1)?.activityAlert).toBe(true);
    for (const phase of ["council", "waiting", "reasoning", "streaming", "reasoning", "streaming"] as const) {
      now += 1000;
      pool.setPoolStatus("gen-1", phase);
      await service.flushLiveActivities();
    }
    expect(deliveries.filter(item => item.activityAlert).map(item => item.state.phase)).toEqual(["assembling", "reasoning", "streaming"]);
    now += 241_000;
    await service.flushLiveActivities();
    expect(deliveries.at(-1)?.activityAlert).toBe(false);
    now += 1000;
    service.refreshLiveActivity(id, credential, tokenBody("cd".repeat(32)));
    await service.flushLiveActivities();
    expect(deliveries.at(-1)?.activityAlert).toBe(false);
    expect((db.query("SELECT delivered_stage FROM ios_live_activities WHERE id = ?").get(id) as any).delivered_stage).toBe(2);
    now += 1000;
    pool.completePool("gen-1", "ready");
    await service.flushLiveActivities();
    expect(deliveries.filter(item => item.activityAlert).map(item => item.state.phase)).toEqual(["assembling", "reasoning", "streaming", "completed"]);
  } finally { clock.mockRestore(); }
});

test("stage migration records prior progress so deployed activities do not replay earlier cues", async () => {
  const legacy = new Database(":memory:");
  try {
    legacy.exec('CREATE TABLE user (id TEXT PRIMARY KEY); CREATE TABLE chats (id TEXT PRIMARY KEY); CREATE TABLE ios_push_destinations (user_id TEXT, device_id TEXT, bundle_id TEXT, environment TEXT);');
    legacy.exec(await Bun.file(new URL("../db/migrations/128_ios_live_activities.sql", import.meta.url)).text());
    for (const phase of [null, "assembling", "reasoning", "streaming", "completed", "error"]) {
      legacy.query(`INSERT INTO ios_live_activities (id, user_id, chat_id, generation_id, device_id, bundle_id, environment, server_origin,
        credential_hash, expires_at, desired_phase, delivered_phase) VALUES (?, 'owner', 'chat', ?, 'device', 'app', 'development', 'https://example.com', 'hash', 1, 'streaming', ?)`)
        .run(String(phase), String(phase), phase);
    }
    legacy.exec(await Bun.file(new URL("../db/migrations/129_ios_activity_stage_sounds.sql", import.meta.url)).text());
    expect(legacy.query("SELECT delivered_stage FROM ios_live_activities ORDER BY rowid").all()).toEqual(
      [-1, 0, 1, 2, 3, 4].map(delivered_stage => ({ delivered_stage })));
  } finally { legacy.close(); }
});

test("foreground and disabled stage cues are consumed without replaying when alerts become available", async () => {
  const clock = spyOn(Date, "now");
  let now = new Date().getTime();
  clock.mockImplementation(() => now);
  try {
    notificationPreferences = { enabled: false };
    const { registrationId: id, credential } = await prepare();
    service.refreshLiveActivity(id, credential, tokenBody());
    await service.flushLiveActivities();
    notificationPreferences = undefined;
    eventBus.setUserVisibility("owner", "another-device", true);
    now += 1000;
    pool.setPoolStatus("gen-1", "reasoning");
    await service.flushLiveActivities();
    eventBus.removeSessionVisibility("owner", "another-device");
    now += 241_000;
    await service.flushLiveActivities();
    expect(deliveries.every(item => !item.activityAlert)).toBe(true);
    now += 1000;
    pool.setPoolStatus("gen-1", "streaming");
    await service.flushLiveActivities();
    expect(deliveries.filter(item => item.activityAlert).map(item => item.state.phase)).toEqual(["streaming"]);
  } finally { clock.mockRestore(); }
});

test("widget stop aborts only the enrolled generation and preserves terminal results on retries", async () => {
  const { registrationId: id, credential } = await prepare();
  const controller = new AbortController(), other = new AbortController();
  const completion = new Promise<void>(resolve => controller.signal.addEventListener('abort', () => { pool.stopPool('gen-1'); resolve(); }));
  registry.registerActiveGeneration('gen-1', { userId: 'owner', chatId: 'chat-1', controller, completion, startedAt: Date.now(), lastTokenAt: Date.now() });
  registry.registerActiveGeneration('newer-generation', { userId: 'owner', chatId: 'chat-1', controller: other, completion: Promise.resolve(), startedAt: Date.now(), lastTokenAt: Date.now() });
  const path = `/native/registrations/${id}/stop`;
  for (const bearer of [undefined, 'x'.repeat(43)]) expect((await request(path, 'POST', undefined, bearer)).status).toBe(401);
  expect(controller.signal.aborted).toBe(false);
  const result = await request(path, 'POST', { generationId: 'newer-generation', userId: 'other' }, credential);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ state: { phase: 'stopped', label: 'Generation stopped' } });
  expect(controller.signal.aborted).toBe(true);
  expect(other.signal.aborted).toBe(false);
  expect((await request(path, 'POST', undefined, credential)).status).toBe(200);
  pool.completePool('gen-1', 'message-1');
  expect(await (await request(path, 'POST', undefined, credential)).json()).toEqual({ state: { phase: 'completed', label: 'Response ready' } });
});

test("widget stop rejects revoked, expired, foreign, or absent active generations", async () => {
  const { registrationId: id, credential } = await prepare();
  const controller = new AbortController();
  const path = `/native/registrations/${id}/stop`;
  expect((await request(path, 'POST', undefined, credential)).status).toBe(409);
  registry.registerActiveGeneration('gen-1', { userId: 'other', chatId: 'chat-2', controller, completion: Promise.resolve(), startedAt: Date.now(), lastTokenAt: Date.now() });
  expect((await request(path, 'POST', undefined, credential)).status).toBe(409);
  expect(controller.signal.aborted).toBe(false);
  db.query('UPDATE ios_live_activities SET expires_at = 1 WHERE id = ?').run(id);
  expect((await request(path, 'POST', undefined, credential)).status).toBe(401);
  const replacement = await prepare();
  await request(`/native/registrations/${replacement.registrationId}`, 'DELETE', undefined, replacement.credential);
  expect((await request(`/native/registrations/${replacement.registrationId}/stop`, 'POST', undefined, replacement.credential)).status).toBe(401);
  expect(controller.signal.aborted).toBe(false);
});

test("avatar access is limited to this enrollment's character and revoked with its credential", async () => {
  const { registrationId: id, credential } = await prepare();
  const path = `/native/registrations/${id}/avatar`;
  for (const bearer of [undefined, "x".repeat(43)]) expect((await request(path, "GET", undefined, bearer)).status).toBe(404);
  const result = await request(path, "GET", undefined, credential);
  expect(result.status).toBe(200);
  expect(result.headers.get("Content-Type")).toBe("image/jpeg");
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  const metadata = await sharp(await result.arrayBuffer()).metadata();
  expect([metadata.width, metadata.height]).toEqual([128, 128]);
  pool.getPoolEntry("gen-1")!.characterId = "foreign-character";
  expect((await request(path, "GET", undefined, credential)).status).toBe(404);
  pool.getPoolEntry("gen-1")!.characterId = "owned";
  db.query("UPDATE ios_live_activities SET expires_at = 1 WHERE id = ?").run(id);
  expect((await request(path, "GET", undefined, credential)).status).toBe(404);
});

test("enrollment is owner-scoped, short-lived, bounded and excludes chat contents", async () => {
  expect((await request("/browser/prepare", "POST", input, undefined, "other")).status).toBe(400);
  for (const bad of [{ deviceId: "x" }, { bundleId: "other.app" }, { serverOrigin: "https://server/path" }, { environment: "bogus" }]) {
    expect((await request("/browser/prepare", "POST", { ...input, ...bad })).status).toBe(400);
  }
  const result = await prepare();
  expect(result.credential).toHaveLength(43);
  const stored = db.query("SELECT * FROM ios_live_activities").get() as any;
  expect(stored.credential_hash).not.toBe(result.credential);
  expect(JSON.stringify(stored)).not.toContain(result.credential);
  expect(stored.expires_at - Date.now()).toBeLessThanOrEqual(8 * 3600_000);
  const text = JSON.stringify(result);
  for (const privateData of ["private message", "private reasoning", "private-provider", "private-model"]) expect(text).not.toContain(privateData);
  expect(text).toContain("Preparing response");
  configured = false;
  expect((await request("/browser/prepare", "POST", input)).status).toBe(503);
});

test("a token arriving after backgrounding catches up to the current phase instead of the prepared snapshot", async () => {
  const enrollment = await prepare();
  expect(enrollment.state.phase).toBe("assembling");
  // ActivityKit token issuance and relay enrollment can outlive the initial
  // foreground snapshot. The native registration reply must catch up directly.
  pool.setPoolStatus("gen-1", "reasoning");
  const response = await request(`/native/registrations/${enrollment.registrationId}`, "PUT", tokenBody(), enrollment.credential);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: { phase: "reasoning", label: "Thinking" } });
  await service.flushLiveActivities();
  expect(deliveries.map(delivery => delivery.state.phase)).toEqual(["reasoning"]);
});

test("native token refresh needs only its scoped credential; it cannot change activity or user", async () => {
  const { registrationId: id, credential } = await prepare();
  expect((await request(`/native/registrations/${id}`, "PUT", tokenBody())).status).toBe(401);
  expect((await request(`/native/registrations/${id}`, "PUT", tokenBody(), "x".repeat(43))).status).toBe(401);
  expect((await request(`/native/registrations/${id}`, "PUT", tokenBody("not-hex"), credential)).status).toBe(400);
  const result = await request(`/native/registrations/${id}`, "PUT", tokenBody(), credential);
  expect(result.status).toBe(200);
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  await service.flushLiveActivities();
  expect(deliveries[0]?.state).toEqual({ phase: "assembling", label: "Preparing response" });
  expect((await request(`/native/registrations/${id}`, "PUT", { ...tokenBody(), activityId: "different" }, credential)).status).toBe(400);
  const replacement = await prepare();
  expect(replacement.registrationId).not.toBe(id);
  expect((await request(`/native/registrations/${id}`, "PUT", tokenBody(), credential)).status).toBe(401);
  expect((await request(`/native/registrations/${replacement.registrationId}`, "DELETE", undefined, replacement.credential)).status).toBe(204);
  expect(db.query("SELECT COUNT(*) AS n FROM ios_live_activities").get()).toEqual({ n: 0 });
});

test("late token enrollment delivers terminal state even when another client is visible", async () => {
  const { registrationId: id, credential } = await prepare();
  eventBus.setUserVisibility("owner", "another-device", true);
  expect(eventBus.isUserVisible("owner")).toBe(true);
  pool.completePool("gen-1", "message-1");
  const result = await request(`/native/registrations/${id}`, "PUT", tokenBody(), credential);
  expect(await result.json()).toEqual({ state: { phase: "completed", label: "Response ready" } });
  await service.flushLiveActivities();
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]?.terminal).toBe(true);
  expect(deliveries[0]?.state.phase).toBe("completed");
  await service.flushLiveActivities();
  expect(deliveries).toHaveLength(1);
});

test("stopped and failed outcomes stay generic and invalidate on current token rejection", async () => {
  for (const phase of ["stopped", "error"] as const) {
    db.exec("DELETE FROM ios_live_activities");
    deliveries.length = 0;
    const { registrationId: id, credential } = await prepare();
    if (phase === "stopped") pool.stopPool("gen-1");
    else pool.errorPool("gen-1", "private provider traceback");
    service.refreshLiveActivity(id, credential, tokenBody());
    await service.flushLiveActivities();
    expect(deliveries[0]?.state.phase).toBe(phase);
    expect(deliveries[0]?.terminal).toBe(phase === "stopped");
    expect(JSON.stringify(deliveries)).not.toContain("private provider traceback");
  }
  db.exec("DELETE FROM ios_live_activities");
  const { registrationId: id, credential } = await prepare();
  respond = async () => ({ sent: false, invalidToken: true });
  service.refreshLiveActivity(id, credential, tokenBody());
  await service.flushLiveActivities();
  expect(service.refreshLiveActivity(id, credential, tokenBody())).toBeNull();
});

test("an invalidation for a previous token cannot delete a rotated registration", async () => {
  const { registrationId: id, credential } = await prepare();
  let release!: (value: { sent: boolean; invalidToken: boolean }) => void;
  respond = () => new Promise(resolve => { release = resolve; });
  service.refreshLiveActivity(id, credential, tokenBody());
  expect(deliveries).toHaveLength(1);
  service.refreshLiveActivity(id, credential, tokenBody("cd".repeat(32)));
  respond = undefined;
  release({ sent: false, invalidToken: true });
  await service.flushLiveActivities();
  expect((db.query("SELECT push_token FROM ios_live_activities WHERE id = ?").get(id) as any).push_token).toBe("cd".repeat(32));
  respond = undefined;
  await service.flushLiveActivities();
  expect(deliveries.at(-1)?.token).toBe("cd".repeat(32));
});

test("a phase arriving during an in-flight push is drained immediately without waiting for polling", async () => {
  const stop = service.initLiveActivityListeners();
  const clock = spyOn(Date, "now");
  let now = Math.floor(new Date().getTime() / 1000) * 1000;
  clock.mockImplementation(() => now);
  try {
    const { registrationId: id, credential } = await prepare();
    let release!: (result: { sent: boolean }) => void;
    respond = () => new Promise(resolve => { release = resolve; });
    service.refreshLiveActivity(id, credential, tokenBody());
    pool.appendPoolReasoning("gen-1", "private reasoning");
    pool.appendPoolContent("gen-1", "private reply");
    now += 1000;
    respond = undefined;
    release({ sent: true });
    await service.flushLiveActivities();
    expect(deliveries.map(item => item.state.phase)).toEqual(["assembling", "streaming"]);
    expect(deliveries.at(-1)?.immediate).toBe(true);
    now += 240_000;
    await service.flushLiveActivities();
    expect(deliveries.at(-1)?.immediate).toBe(false);
  } finally { stop(); clock.mockRestore(); }
});

test("same-second thinking to writing transitions retry at the next timestamp boundary", async () => {
  const stop = service.initLiveActivityListeners();
  try {
    const { registrationId: id, credential } = await prepare();
    pool.appendPoolReasoning("gen-1", "reasoning");
    service.refreshLiveActivity(id, credential, tokenBody());
    await service.flushLiveActivities();
    expect(deliveries.at(-1)?.state.phase).toBe("reasoning");
    const start = Date.now();
    pool.appendPoolContent("gen-1", "reply");
    await service.flushLiveActivities();
    while (deliveries.at(-1)?.state.phase !== "streaming" && Date.now() - start < 1400) await Bun.sleep(10);
    expect(deliveries.at(-1)?.state.phase).toBe("streaming");
    expect(deliveries.at(-1)?.timestamp).toBeGreaterThan(deliveries[0]!.timestamp);
    expect(deliveries.at(-1)?.immediate).toBe(true);
    expect(Date.now() - start).toBeLessThan(1400);
  } finally { stop(); await service.flushLiveActivities(); }
});

test("backend restart recovery ends missing generations and retries provider failures", async () => {
  const { registrationId: id, credential } = await prepare();
  respond = async () => ({ sent: false });
  service.refreshLiveActivity(id, credential, tokenBody());
  await service.flushLiveActivities();
  expect((db.query("SELECT attempts FROM ios_live_activities WHERE id = ?").get(id) as any).attempts).toBe(1);
  pool.clearAllPoolEntries();
  respond = undefined;
  db.exec("UPDATE ios_live_activities SET next_attempt_at = 0");
  await service.flushLiveActivities();
  expect(deliveries.at(-1)?.state.phase).toBe("interrupted");
  expect(deliveries.at(-1)?.terminal).toBe(true);
});

test("pool-driven phases, council attention, and terminal events remain generation-scoped", async () => {
  const stop = service.initLiveActivityListeners();
  try {
    const { registrationId: id, credential } = await prepare();
    service.refreshLiveActivity(id, credential, tokenBody());
    await service.flushLiveActivities();
    pool.getPoolEntry("gen-1")!.councilRetryPending = true;
    db.exec("UPDATE ios_live_activities SET last_timestamp = 0");
    await service.flushLiveActivities();
    expect(deliveries.at(-1)?.state.phase).toBe("inputNeeded");
    pool.createPoolEntry({ generationId: "gen-2", userId: "owner", chatId: "chat-1", generationType: "normal" as any, characterName: "Lumi", model: "x" });
    const newer = await prepare("gen-2");
    pool.completePool("gen-1", "message-1");
    eventBus.emit(EventType.GENERATION_ENDED, { generationId: "gen-1", chatId: "chat-1" }, "owner");
    await new Promise(resolve => setTimeout(resolve, 30));
    const oldRow = db.query("SELECT desired_phase FROM ios_live_activities WHERE id = ?").get(id) as any;
    const newRow = db.query("SELECT desired_phase FROM ios_live_activities WHERE id = ?").get(newer.registrationId) as any;
    expect(oldRow.desired_phase).toBe("completed");
    expect(newRow.desired_phase).toBe("assembling");
  } finally { stop(); await service.flushLiveActivities(); }
});

test("expiry, chat deletion, and alert destination removal revoke activity credentials", async () => {
  const first = await prepare();
  db.exec("UPDATE ios_live_activities SET expires_at = 1");
  expect(service.refreshLiveActivity(first.registrationId, first.credential, tokenBody())).toBeNull();
  const second = await prepare();
  db.query(`INSERT INTO ios_push_destinations (id, user_id, device_id, device_token, bundle_id, environment, server_origin, registered_at)
    VALUES ('phone', 'owner', ?, ?, ?, ?, ?, ?)`).run(input.deviceId, "ef".repeat(32), input.bundleId, input.environment, input.serverOrigin, Date.now());
  db.exec("DELETE FROM ios_push_destinations WHERE id = 'phone'");
  expect(service.refreshLiveActivity(second.registrationId, second.credential, tokenBody())).toBeNull();
  const third = await prepare();
  db.exec("DELETE FROM chats WHERE id = 'chat-1'");
  expect(service.refreshLiveActivity(third.registrationId, third.credential, tokenBody())).toBeNull();
  db.exec("INSERT INTO chats VALUES ('chat-1')");
});

test("foreground snapshots omit private content and fail closed for missing/foreign generations", async () => {
  const result = await request("/browser/snapshot", "POST", { generationIds: ["gen-1", "missing"] });
  expect(await result.json()).toEqual({ active: [{ generationId: "gen-1" }], existing: [
    { generationId: "gen-1", state: { phase: "assembling", label: "Preparing response" } },
    { generationId: "missing", state: { phase: "interrupted", label: "Generation unavailable" } },
  ] });
  const foreign = await request("/browser/snapshot", "POST", { generationIds: ["gen-1"] }, undefined, "other");
  expect((await foreign.json() as any).existing[0].state.phase).toBe("interrupted");
  expect((await request("/browser/snapshot", "POST", { generationIds: Array(33).fill("gen-1") })).status).toBe(400);
});
