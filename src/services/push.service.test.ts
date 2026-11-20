import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { eventBus } from "../ws/bus";

const db = new Database(":memory:");
db.exec(await Bun.file(new URL("../db/migrations/035_push_subscriptions.sql", import.meta.url)).text());
db.exec(await Bun.file(new URL("../db/migrations/117_desktop_notification_destinations.sql", import.meta.url)).text());
db.exec(await Bun.file(new URL("../db/migrations/127_ios_push_destinations.sql", import.meta.url)).text());
db.exec(await Bun.file(new URL("../db/migrations/130_android_push_destinations.sql", import.meta.url)).text());
db.exec(await Bun.file(new URL("../db/migrations/133_android_notification_relay.sql", import.meta.url)).text());
db.exec(`
  CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, character_id TEXT);
  CREATE TABLE characters (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL);
`);
db.exec(await Bun.file(new URL("../db/migrations/128_ios_live_activities.sql", import.meta.url)).text());
db.exec(await Bun.file(new URL("../db/migrations/131_ios_notification_delivery.sql", import.meta.url)).text());
mock.module("../crypto/init", () => ({ getEncryptionKeyBytes: () => new Uint8Array(32).fill(41) }));
let pushNotificationPreferences: Record<string, unknown> | null = null;
const builtPayloads: Array<Record<string, unknown>> = [];
mock.module("../db/connection", () => ({ getDb: () => db }));
mock.module("./settings.service", () => ({
  getSetting: () => pushNotificationPreferences === null
    ? null
    : { value: pushNotificationPreferences },
}));
mock.module("../crypto/vapid", () => ({ getVapidPrivateJWK: () => ({}), getVapidPublicKey: () => "test-key" }));
mock.module("@pushforge/builder", () => ({
  buildPushHTTPRequest: async ({ subscription, message }: {
    subscription: { endpoint: string };
    message: { payload: Record<string, unknown> };
  }) => {
    builtPayloads.push(message.payload);
    return { endpoint: subscription.endpoint, headers: {}, body: "encrypted-payload" };
  },
}));
const validateHost = mock(async (_hostname: string) => {});
mock.module("../utils/safe-fetch", () => ({ validateHost, SSRFError: class extends Error {} }));
let apnsConfigured = true;
let apnsDelivery: "direct" | "relay" = "direct";
const sendAPNsNotification = mock(async (_destination: unknown, _payload: unknown): Promise<{ sent: boolean; invalidatedAt?: number }> => ({ sent: true }));
mock.module("./apns.service", () => ({
  getAPNsInfo: () => ({ configured: apnsConfigured, bundleId: "chat.lumiverse.ios", delivery: apnsDelivery, reason: apnsConfigured ? null : "APNs key missing" }),
  sendAPNsNotification,
}));

const {
  authenticateDesktopDestinationCredential,
  createDesktopDestination,
  createIOSDestination,
  createSubscription,
  dispatchGenerationEndedPush,
  listNotificationDestinations,
  listSubscriptions,
  sendPushToUser,
} = await import("./push.service");
const { pushRoutes } = await import("../routes/push.routes");
const {
  desktopNotificationTransportRoutes,
  parseDesktopNotificationMediaPath,
} = await import("../routes/desktop-notifications.routes");
const { consumeDesktopNotificationTicket } = await import("../ws/tickets");
const userId = "push-test-user";
const originalFetch = globalThis.fetch;
const fetchMock = mock(async () => new Response(null, { status: 201 }));
globalThis.fetch = fetchMock as unknown as typeof fetch;

const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
app.route("/push", pushRoutes);
app.route("/desktop-notifications", desktopNotificationTransportRoutes);

beforeEach(() => {
  db.exec("DELETE FROM ios_live_activities");
  db.exec("DELETE FROM push_subscriptions");
  db.exec("DELETE FROM desktop_notification_destinations");
  db.exec("DELETE FROM ios_push_destinations");
  db.exec("DELETE FROM chats");
  db.exec("DELETE FROM characters");
  fetchMock.mockClear();
  builtPayloads.length = 0;
  apnsConfigured = true;
  apnsDelivery = "direct";
  sendAPNsNotification.mockReset();
  sendAPNsNotification.mockImplementation(async () => ({ sent: true }));
  pushNotificationPreferences = null;
  validateHost.mockReset();
  validateHost.mockImplementation(async () => {});
  for (const device of ["phone", "desktop"]) {
    eventBus.removeSessionVisibility(userId, device);
    createSubscription(userId, {
      endpoint: `https://push.example.com/${device}`, keys: { p256dh: "key", auth: "auth" },
    });
  }
});

afterAll(() => {
  for (const device of ["phone", "desktop"]) eventBus.removeSessionVisibility(userId, device);
  globalThis.fetch = originalFetch;
  db.close();
  mock.restore();
});

describe("push presence suppression", () => {
  const iosInput = { deviceId: "iphone-install-123456", deviceToken: "ab".repeat(32), bundleId: "chat.lumiverse.ios",
    environment: "development" as const, serverOrigin: "https://lumiverse.example.com" };

  test("relay enrollment requires device proof credentials and stores secrets encrypted without exposing them", () => {
    apnsDelivery = "relay";
    expect(() => createIOSDestination(userId, iosInput)).toThrow("complete relay verification");
    const key = Buffer.alloc(32, 23), encryption = { key: key.toString("base64"), keyId: createHash("sha256").update(key).digest("hex").slice(0, 32) };
    const relayCredential = "lvr_" + "a".repeat(43);
    expect(() => createIOSDestination(userId, { ...iosInput, encryption, relayCredential: "invalid" })).toThrow();
    expect(() => createIOSDestination(userId, { ...iosInput, encryption, relayCredential, delivery: "direct" })).toThrow("route changed");
    const destination = createIOSDestination(userId, { ...iosInput, encryption, relayCredential, delivery: "relay" });
    expect(destination.delivery_mode).toBe("relay");
    const listed = JSON.stringify(listNotificationDestinations(userId));
    expect(listed).not.toContain(relayCredential); expect(listed).not.toContain(encryption.key);
    const stored = db.query("SELECT relay_credential, encryption_key FROM ios_push_destinations WHERE id = ?").get(destination.id) as any;
    expect(stored.relay_credential).toStartWith("lvns1:"); expect(stored.encryption_key).toStartWith("lvns1:");
    expect(JSON.stringify(stored)).not.toContain(relayCredential); expect(JSON.stringify(stored)).not.toContain(encryption.key);
  });

  function enrollActivity(overrides: Record<string, unknown> = {}) {
    const row = { id: crypto.randomUUID(), user_id: userId, chat_id: "chat-1", generation_id: "gen-1",
      device_id: iosInput.deviceId, bundle_id: iosInput.bundleId, environment: iosInput.environment, server_origin: iosInput.serverOrigin,
      credential_hash: "hash", expires_at: Date.now() + 60_000, desired_phase: "streaming",
      activity_id: "activity-1", push_token: "aa".repeat(32), ended_at: null, ...overrides };
    db.query(`INSERT INTO ios_live_activities (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
      .run(...Object.values(row) as any[]);
  }

  test("an enrolled Live Activity replaces only its own iPhone's generation alert", async () => {
    createIOSDestination(userId, iosInput);
    const second = createIOSDestination(userId, { ...iosInput, deviceId: "second-iphone-123456", deviceToken: "cd".repeat(32) });
    enrollActivity();
    for (const outcome of [{ content: "Ready" }, { error: "Provider unavailable" }]) {
      sendAPNsNotification.mockClear();
      expect(await dispatchGenerationEndedPush(userId, { generationId: "gen-1", chatId: "chat-1", ...outcome })).toEqual({ sent: 3 });
      expect(sendAPNsNotification).toHaveBeenCalledTimes(1);
      expect(sendAPNsNotification.mock.calls[0]![0]).toMatchObject({ id: second.id });
    }
    // The terminal sender may already have marked the activity ended.
    db.query("UPDATE ios_live_activities SET ended_at = ?, desired_phase = 'completed', delivered_phase = 'completed'").run(Date.now());
    sendAPNsNotification.mockClear();
    expect(await dispatchGenerationEndedPush(userId, { generationId: "gen-1", content: "Ready" })).toEqual({ sent: 3 });
    expect(sendAPNsNotification).toHaveBeenCalledTimes(1);
  });

  test("missing, hidden, expired, unstarted and unrelated activities keep standard push delivery", async () => {
    const destination = createIOSDestination(userId, iosInput);
    const dispatch = () => dispatchGenerationEndedPush(userId, { generationId: "gen-1", content: "Ready" }, { destinationId: destination.id });
    expect(await dispatch()).toEqual({ sent: 1 });
    for (const overrides of [{ activity_id: null, push_token: null }, { push_token: null }, { expires_at: 1 },
      { generation_id: "gen-older" }, { user_id: "another-user" }, { device_id: "other-phone-12345" },
      { bundle_id: "chat.other.ios" }, { environment: "production" }, { server_origin: "https://other.example.com" },
      { ended_at: Date.now() - 121_000 }]) {
      db.exec("DELETE FROM ios_live_activities");
      enrollActivity(overrides);
      expect(await dispatch()).toEqual({ sent: 1 });
    }
    db.exec("DELETE FROM ios_live_activities"); // Hide/revoke removes the enrollment.
    expect(await dispatch()).toEqual({ sent: 1 });
    enrollActivity();
    expect(await dispatchGenerationEndedPush(userId, { content: "Test" }, { destinationId: destination.id, bypassPresence: true }))
      .toEqual({ sent: 1 });
  });

  test("registers native iOS destinations without leaking tokens and rotates them in place", () => {
    const first = createIOSDestination(userId, iosInput);
    const second = createIOSDestination(userId, { ...iosInput, deviceToken: "cd".repeat(32) });
    expect(first.type).toBe("ios_apns");
    expect(second.id).toBe(first.id);
    expect(JSON.stringify(listNotificationDestinations(userId))).not.toContain(iosInput.deviceToken);
    expect(listNotificationDestinations(userId).filter(row => row.type === "ios_apns")).toHaveLength(1);
  });

  test("moves a token to the newly enrolling account", () => {
    createIOSDestination(userId, iosInput);
    createIOSDestination("another-user", { ...iosInput, deviceId: "another-installation-1234" });
    expect(listNotificationDestinations(userId).filter(row => row.type === "ios_apns")).toHaveLength(0);
    expect(listNotificationDestinations("another-user").filter(row => row.type === "ios_apns")).toHaveLength(1);
  });

  test("native push can deliver with no browser subscription or connected WebSocket", async () => {
    const destination = createIOSDestination(userId, iosInput);
    expect(await sendPushToUser(userId, { title: "Hello", body: "From APNs" }, { destinationId: destination.id })).toBe(1);
    expect(sendAPNsNotification).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(builtPayloads).toHaveLength(0);
  });

  test("does not delete a recently refreshed token after an older APNs invalidation", async () => {
    createIOSDestination(userId, iosInput);
    sendAPNsNotification.mockImplementation(async () => ({ sent: false, invalidatedAt: Date.now() - 60_000 }));
    await sendPushToUser(userId, { title: "Hello", body: "Old receipt" });
    expect(listNotificationDestinations(userId).some(row => row.type === "ios_apns")).toBe(true);
    sendAPNsNotification.mockImplementation(async () => ({ sent: false, invalidatedAt: Date.now() + 1000 }));
    await sendPushToUser(userId, { title: "Hello", body: "Expired token" });
    expect(listNotificationDestinations(userId).some(row => row.type === "ios_apns")).toBe(false);
  });

  test("APNs configuration and destination validation return actionable errors", async () => {
    apnsConfigured = false;
    const disabled = await app.request("/push/ios", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(iosInput) });
    expect(disabled.status).toBe(503);
    apnsConfigured = true;
    for (const patch of [{ deviceToken: "../../../bad" }, { bundleId: "other.app" }, { environment: "fake" }, { serverOrigin: "file:///secret" }]) {
      const response = await app.request("/push/ios", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...iosInput, ...patch }) });
      expect(response.status).toBe(400);
    }
    const created = createIOSDestination(userId, iosInput);
    // Another user's destination cannot be removed through the current session.
    const other = createIOSDestination("another-user", { ...iosInput, deviceToken: "ef".repeat(32) });
    expect((await app.request(`/push/subscriptions/${other.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await app.request(`/push/subscriptions/${created.id}`, { method: "DELETE" })).status).toBe(200);
  });
  test.each(["phone", "desktop"])("suppresses generation and extension pushes while %s is visible", async (visibleDevice) => {
    eventBus.setUserVisibility(userId, "phone", visibleDevice === "phone");
    eventBus.setUserVisibility(userId, "desktop", visibleDevice === "desktop");

    expect(await dispatchGenerationEndedPush(userId, { content: "Done" })).toEqual({ sent: 0, reason: "user_active" });
    expect(await sendPushToUser(userId, { title: "Extension", body: "Done" })).toBe(0);
    const response = await app.request("/push/subscriptions/test", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, sent: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(listSubscriptions(userId)).toHaveLength(2);
  });

  test("delivers to both devices once all sessions are hidden", async () => {
    eventBus.setUserVisibility(userId, "phone", false);
    eventBus.setUserVisibility(userId, "desktop", false);
    expect(await dispatchGenerationEndedPush(userId, { content: "Done" })).toEqual({ sent: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("delivers when no app sessions are connected", async () => {
    expect(await dispatchGenerationEndedPush(userId, { content: "Done" })).toEqual({ sent: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("adds the owned chat character avatar as the notification thumbnail", async () => {
    db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)")
      .run("char-1", userId, "Alice");
    db.query("INSERT INTO chats (id, user_id, character_id) VALUES (?, ?, ?)")
      .run("chat-1", userId, "char-1");

    expect(await dispatchGenerationEndedPush(userId, {
      chatId: "chat-1",
      content: "Done",
    })).toEqual({ sent: 2 });
    expect(builtPayloads).toHaveLength(2);
    expect(builtPayloads[0]).toMatchObject({
      title: "Alice",
      icon: "/api/v1/characters/char-1/avatar?size=sm",
    });
  });

  test("registers a durable desktop credential without exposing it in destination listings", () => {
    const first = createDesktopDestination(userId, {
      deviceId: "desktop-device-123456",
      label: "Lumiverse Desktop",
      platform: "macOS",
    });
    expect(first.credential).toStartWith("lvd_");
    expect(first.destination).toMatchObject({
      type: "tauri_desktop",
      device_id: "desktop-device-123456",
      label: "Lumiverse Desktop",
      platform: "macOS",
    });
    expect(authenticateDesktopDestinationCredential(first.credential)).toEqual({
      userId,
      destinationId: first.destination.id,
    });
    expect(JSON.stringify(listNotificationDestinations(userId))).not.toContain(first.credential);

    const rotated = createDesktopDestination(userId, {
      deviceId: "desktop-device-123456",
    });
    expect(rotated.destination.id).toBe(first.destination.id);
    expect(authenticateDesktopDestinationCredential(first.credential)).toBeNull();
    expect(authenticateDesktopDestinationCredential(rotated.credential)).toEqual({
      userId,
      destinationId: first.destination.id,
    });
  });

  test("delivers backend payloads over a connected notification-only desktop socket", async () => {
    const enrollment = createDesktopDestination(userId, {
      deviceId: "desktop-device-connected",
      label: "Lumiverse Desktop",
    });
    const frames: string[] = [];
    const closes: Array<[number, string]> = [];
    const desktopSocket = {
      readyState: 1,
      send: (frame: string) => frames.push(frame),
      close: (code: number, reason: string) => closes.push([code, reason]),
    } as any;
    eventBus.addDesktopNotificationClient(desktopSocket, userId, enrollment.destination.id);
    try {
      expect(await dispatchGenerationEndedPush(userId, { content: "Native done" })).toEqual({ sent: 3 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(frames).toHaveLength(1);
      expect(JSON.parse(frames[0])).toMatchObject({
        event: "DESKTOP_NOTIFICATION",
        payload: { title: "Lumiverse", body: "Native done" },
      });
      createDesktopDestination(userId, {
        deviceId: "desktop-device-connected",
        label: "Lumiverse Desktop",
      });
      expect(closes).toEqual([[1008, "Desktop notification destination revoked"]]);
    } finally {
      eventBus.removeClient(desktopSocket);
    }
  });

  test("converts notification HTML to plain text before every delivery", async () => {
    const enrollment = createDesktopDestination(userId, {
      deviceId: "desktop-device-plain-text",
    });
    const frames: string[] = [];
    const desktopSocket = {
      readyState: 1,
      send: (frame: string) => frames.push(frame),
      close: () => {},
    } as any;
    eventBus.addDesktopNotificationClient(desktopSocket, userId, enrollment.destination.id);
    try {
      expect(await sendPushToUser(userId, {
        title: "<font color='red'>Alert</font>",
        body: "<div>First</div><div>Second<br>Third</div>",
      })).toBe(3);
      expect(builtPayloads).toHaveLength(2);
      expect(builtPayloads[0]).toMatchObject({
        title: "Alert",
        body: "First\nSecond\nThird",
      });
      expect(JSON.parse(frames[0])).toMatchObject({
        payload: {
          title: "Alert",
          body: "First\nSecond\nThird",
        },
      });
    } finally {
      eventBus.removeClient(desktopSocket);
    }
  });

  test("exchanges the durable credential for a single-use notification ticket", async () => {
    const enrollment = createDesktopDestination(userId, {
      deviceId: "desktop-device-ticket",
    });
    const response = await app.request("/desktop-notifications/ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${enrollment.credential}` },
    });
    expect(response.status).toBe(200);
    const { ticket } = await response.json() as { ticket: string };
    expect(consumeDesktopNotificationTicket(ticket)).toEqual({
      userId,
      destinationId: enrollment.destination.id,
    });
    expect(consumeDesktopNotificationTicket(ticket)).toBeNull();

    const pendingResponse = await app.request("/desktop-notifications/ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${enrollment.credential}` },
    });
    const pending = await pendingResponse.json() as { ticket: string };
    createDesktopDestination(userId, { deviceId: "desktop-device-ticket" });
    expect(consumeDesktopNotificationTicket(pending.ticket)).toBeNull();

    const rejected = await app.request("/desktop-notifications/ticket", {
      method: "POST",
      headers: { authorization: "Bearer lvd_invalid" },
    });
    expect(rejected.status).toBe(401);
  });

  test("limits desktop media credentials to supported user-owned image paths", async () => {
    expect(parseDesktopNotificationMediaPath("/api/v1/characters/char-1/avatar?size=sm")).toEqual({
      kind: "character_avatar",
      id: "char-1",
      size: "sm",
    });
    expect(parseDesktopNotificationMediaPath("/api/v1/images/image_1?size=lg")).toEqual({
      kind: "image",
      id: "image_1",
      size: "lg",
    });
    for (const invalid of [
      "//attacker.example/image.png",
      "https://attacker.example/image.png",
      "/api/v1/characters/char-1/avatar?variant=original",
      "/api/v1/images/image-1?size=full",
      "/api/v1/secrets",
    ]) {
      expect(parseDesktopNotificationMediaPath(invalid)).toBeNull();
    }

    const enrollment = createDesktopDestination(userId, {
      deviceId: "desktop-device-media-scope",
    });
    const rejected = await app.request(
      "/desktop-notifications/media?path=%2Fapi%2Fv1%2Fsecrets",
      { headers: { authorization: `Bearer ${enrollment.credential}` } },
    );
    expect(rejected.status).toBe(400);
  });

  test("includes generation failure diagnostics and connection name", async () => {
    expect(await dispatchGenerationEndedPush(userId, {
      chatId: "chat-1",
      error: "OpenAI stream failed (429): Too many requests",
      errorCode: "rate_limit_exceeded",
      errorMessage: "OpenAI stream failed (429): Too many requests",
      connectionName: "Primary OpenAI",
    })).toEqual({ sent: 2 });

    expect(builtPayloads).toHaveLength(2);
    expect(builtPayloads[0]).toMatchObject({
      title: "Generation Failed · Primary OpenAI",
      body: "[rate_limit_exceeded] OpenAI stream failed (429): Too many requests",
      tag: "generation-error-chat-1",
      data: {
        url: "/chat/chat-1",
        chatId: "chat-1",
        connectionName: "Primary OpenAI",
        errorCode: "rate_limit_exceeded",
        errorMessage: "OpenAI stream failed (429): Too many requests",
      },
    });
  });

  test("honors an explicit generation failure notification opt-out", async () => {
    pushNotificationPreferences = {
      enabled: true,
      events: { generation_ended: true, generation_error: false },
    };

    expect(await dispatchGenerationEndedPush(userId, {
      error: "Provider unavailable",
      errorCode: "unavailable",
      errorMessage: "Provider unavailable",
      connectionName: "Local model",
    })).toEqual({ sent: 0, reason: "event_disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(builtPayloads).toHaveLength(0);
  });

  test("cancels delivery if the user returns during push preparation", async () => {
    const started = Promise.withResolvers<void>();
    const validated = Promise.withResolvers<void>();
    validateHost.mockImplementation(() => { started.resolve(); return validated.promise; });

    const pending = sendPushToUser(userId, { title: "Character", body: "Done" });
    await started.promise;
    eventBus.setUserVisibility(userId, "phone", true);
    validated.resolve();

    expect(await pending).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listSubscriptions(userId)).toHaveLength(2);
  });
});
