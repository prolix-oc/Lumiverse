import { afterAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const directory = mkdtempSync(join(tmpdir(), "lumiverse-apns-test-"));
const keyPath = join(directory, "AuthKey.p8");
writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
const variables = ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY_PATH", "APNS_BUNDLE_ID",
  "APNS_CERTIFICATE_PATH", "APNS_PRIVATE_KEY_PASSPHRASE_FILE", "APNS_PRIVATE_KEY_PASSPHRASE",
  "APNS_LIVE_ACTIVITY_PRIVATE_KEY_PATH", "APNS_LIVE_ACTIVITY_TEAM_ID", "APNS_LIVE_ACTIVITY_KEY_ID",
  "APNS_LIVE_ACTIVITY_PRIVATE_KEY_PASSPHRASE_FILE", "APNS_LIVE_ACTIVITY_PRIVATE_KEY_PASSPHRASE"];
const previous = Object.fromEntries(variables.map(key => [key, process.env[key]]));
for (const key of variables) delete process.env[key];
Object.assign(process.env, { APNS_TEAM_ID: "TEAM123456", APNS_KEY_ID: "KEY1234567", APNS_PRIVATE_KEY_PATH: keyPath, APNS_BUNDLE_ID: "chat.lumiverse.ios" });
let responseStatus = 200, responseBody = "", authority = "", lastHeaders: Record<string, unknown> = {}, lastPayload = "";
let requestCount = 0;
class Session extends EventEmitter {
  closed = false; destroyed = false;
  setTimeout() {} unref() {} close() { this.closed = true } destroy() { this.destroyed = true }
  request(headers: Record<string, unknown>) {
    requestCount++; lastHeaders = headers;
    const stream = new EventEmitter() as EventEmitter & { setEncoding(): void; end(body: string): void; destroy(error: Error): void };
    stream.setEncoding = () => {};
    stream.destroy = error => { stream.emit("error", error); stream.emit("close") };
    stream.end = body => {
      lastPayload = body;
      queueMicrotask(() => { stream.emit("response", { ":status": responseStatus }); stream.emit("data", responseBody); stream.emit("end"); stream.emit("close") });
    };
    return stream;
  }
}
mock.module("node:http2", () => ({ connect: (url: string) => { authority = url; return new Session() } }));
mock.module("../crypto/init", () => ({ getEncryptionKeyBytes: () => new Uint8Array(32).fill(23) }));
const { createAPNsJWT, buildAPNsPayload, sendAPNsNotification, getAPNsInfo, sendAPNsLiveActivity, getLiveActivityAPNsInfo, IOS_COMPLETION_SOUND } = await import("./apns.service");
afterAll(() => {
  for (const key of variables) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
  rmSync(directory, { recursive: true, force: true });
  mock.restore();
});

describe("native APNs provider", () => {
  test("uses the synthesized tone for completion and leaves errors and generic alerts unchanged", async () => {
    expect(JSON.parse(buildAPNsPayload({ title: "Lumi", body: "Ready", tag: "generation-chat-1" })).aps.sound).toBe(IOS_COMPLETION_SOUND);
    for (const tag of [undefined, "generation-error-chat-1", "extension-alert"]) {
      expect(JSON.parse(buildAPNsPayload({ title: "Alert", body: "Test", tag })).aps.sound).toBe("default");
    }
    expect(JSON.parse(buildAPNsPayload({ title: "Failed", body: "Error", tag: "generation-chat-1", data: { errorMessage: "Failed" } })).aps.sound).toBe("default");
    responseStatus = 200; responseBody = "";
    const destination = { device_token: "ab".repeat(32), bundle_id: "chat.lumiverse.ios", environment: "development" as const };
    await sendAPNsLiveActivity(destination, { phase: "completed", label: "Response ready" }, 123456, false, true, true);
    expect(JSON.parse(lastPayload).aps).toMatchObject({ event: "update", alert: { sound: IOS_COMPLETION_SOUND, title: "Response ready" } });
    expect(JSON.parse(lastPayload).aps['dismissal-date']).toBeUndefined();
    await sendAPNsLiveActivity(destination, { phase: "error", label: "Generation failed" }, 123456, false, true, true);
    expect(JSON.parse(lastPayload).aps).toMatchObject({ event: "update", alert: { sound: "default", title: "Generation failed" } });
    for (const [phase, enabled] of [["completed", false], ["stopped", true], ["error", false], ["streaming", false]] as const) {
      await sendAPNsLiveActivity(destination, { phase, label: phase }, 123457, phase !== "streaming", true, enabled);
      expect(JSON.parse(lastPayload).aps.alert).toBeUndefined();
    }
    await sendAPNsLiveActivity(destination, { phase: "completed", label: "Response ready" }, 123467, true, true, true);
    expect(JSON.parse(lastPayload).aps).toMatchObject({ event: "end", 'dismissal-date': 123587 });
    expect(JSON.parse(lastPayload).aps.alert).toBeUndefined();
  });
  test("stage alerts use their distinct bundled tones while heartbeats and end events stay silent", async () => {
    const destination = { device_token: "ab".repeat(32), bundle_id: "chat.lumiverse.ios", environment: "development" as const };
    for (const [phase, sound] of Object.entries({ assembling: "prepare", council: "prepare", waiting: "prepare", reasoning: "think", streaming: "respond" })) {
      await sendAPNsLiveActivity(destination, { phase, label: phase }, 123456, false, true, true);
      expect(JSON.parse(lastPayload).aps).toMatchObject({ event: "update", alert: { sound: `lumiverse-${sound}.wav` } });
      await sendAPNsLiveActivity(destination, { phase, label: phase }, 123457, false, false, false);
      expect(JSON.parse(lastPayload).aps.alert).toBeUndefined();
      await sendAPNsLiveActivity(destination, { phase, label: phase }, 123458, true, true, true);
      expect(JSON.parse(lastPayload).aps.alert).toBeUndefined();
    }
  });
  test("sends ActivityKit updates and endings with independent APNs topics and priorities", async () => {
    responseStatus = 200; responseBody = "";
    const destination = { device_token: "12".repeat(32), bundle_id: "chat.lumiverse.ios", environment: "development" as const };
    expect(getLiveActivityAPNsInfo().configured).toBe(true);
    expect(await sendAPNsLiveActivity(destination, { phase: "streaming", label: "Writing response" }, 123456, false)).toEqual({ sent: true });
    expect(lastHeaders).toMatchObject({ ":path": `/3/device/${destination.device_token}`, "apns-push-type": "liveactivity",
      "apns-topic": "chat.lumiverse.ios.push-type.liveactivity", "apns-priority": "10" });
    expect(lastHeaders.authorization).toMatch(/^bearer /);
    const providerAuthorization = lastHeaders.authorization;
    await sendAPNsNotification({ ...destination, server_origin: 'https://lumiverse.example' }, { title: 'Ready', body: 'Done' });
    expect(lastHeaders.authorization).toBe(providerAuthorization);
    await sendAPNsLiveActivity(destination, { phase: "streaming", label: "Writing response" }, 123456, false);
    expect(lastHeaders.authorization).toBe(providerAuthorization);
    expect(JSON.parse(lastPayload)).toEqual({ aps: { timestamp: 123456, event: "update",
      "content-state": { phase: "streaming", label: "Writing response" }, "stale-date": 123756 } });
    await sendAPNsLiveActivity(destination, { phase: "streaming", label: "Writing response" }, 123456, false, false);
    expect(lastHeaders['apns-priority']).toBe("5"); // Unchanged heartbeat preserves the high-priority budget.
    await sendAPNsLiveActivity(destination, { phase: "completed", label: "Response ready" }, 123457, true);
    expect(lastHeaders['apns-priority']).toBe("10");
    expect(JSON.parse(lastPayload).aps).toMatchObject({ event: "end", "dismissal-date": 123577 });
    await sendAPNsLiveActivity(destination, { phase: "inputNeeded", label: "Input needed" }, 123458, false);
    expect(lastHeaders['apns-priority']).toBe("10");
    responseStatus = 400; responseBody = JSON.stringify({ reason: "BadDeviceToken" });
    expect(await sendAPNsLiveActivity(destination, { phase: "streaming", label: "Writing response" }, 123459, false))
      .toEqual({ sent: false, invalidToken: true });
    responseStatus = 200; responseBody = "";
  });
  test("enriches character messages and preserves ordinary errors and generic alerts", () => {
    const notification = { title: "Lumi", body: "Hello", data: { chatId: "chat-1", characterName: "Lumi" },
      icon: "/api/v1/characters/char-1/avatar?size=sm" };
    const payload = JSON.parse(buildAPNsPayload(notification, "https://lumiverse.example", "/api/ios-notifications/v1/avatar/signed"));
    expect(payload.aps).toMatchObject({ "mutable-content": 1, "thread-id": "chat-1", alert: { title: "Lumi", body: "Hello" } });
    expect(payload.communication).toEqual({ senderId: "char-1", senderName: "Lumi", avatarPath: "/api/ios-notifications/v1/avatar/signed" });
    const formattedName = JSON.parse(buildAPNsPayload({ ...notification, data: { ...notification.data, characterName: '<b>Lumi</b>' } },
      "https://lumiverse.example", "/signed"));
    expect(formattedName.communication.senderName).toBe('Lumi');
    for (const ordinary of [notification, { title: "Test", body: "Done" },
      { ...notification, title: "Generation Failed", data: { ...notification.data, errorMessage: "Provider offline" } }]) {
      const plain = JSON.parse(buildAPNsPayload(ordinary, "https://lumiverse.example"));
      expect(plain.communication).toBeUndefined();
      expect(plain.aps["mutable-content"]).toBeUndefined();
      expect(plain.aps.alert.title).toBe(ordinary.title);
    }
    const error = JSON.parse(buildAPNsPayload({ ...notification, tag: "generation-error-chat-1" }, "https://lumiverse.example", "/signed"));
    expect(error.communication).toBeUndefined();
    const oversized = buildAPNsPayload({ ...notification, body: "\u0000".repeat(4000) }, "https://lumiverse.example", "/".repeat(5000));
    expect(Buffer.byteLength(oversized)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(oversized).communication).toBeUndefined();
  });
  test("creates a verifiable ES256 JWT with Apple's key and team fields", () => {
    const token = createAPNsJWT({ teamId: "TEAM123456", keyId: "KEY1234567", bundleId: "chat.lumiverse.ios", privateKey }, 1234567890);
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ iss: "TEAM123456", iat: 1234567890 });
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
    expect(JSON.stringify(getAPNsInfo())).not.toContain("PRIVATE KEY");
  });
  test("bounds the serialized UTF-8 payload and accepts only chat identifiers for navigation", () => {
    const payload = buildAPNsPayload({ title: "✨".repeat(1000), body: "\u0000😀\n".repeat(2000), data: { chatId: "../other", url: "https://evil.example" } }, "https://lumiverse.example.com");
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(payload)).not.toHaveProperty("chatId");
    expect(payload).not.toContain("evil.example");
    expect(JSON.parse(buildAPNsPayload({ title: "Ready", body: "Done", data: { chatId: "chat-123" } }))).toHaveProperty("chatId", "chat-123");
  });
  test("uses HTTP/2 with the correct APNs environment and alert headers", async () => {
    const destination = { device_token: "ab".repeat(32), bundle_id: "chat.lumiverse.ios", environment: "development" as const, server_origin: "https://lumiverse.example.com" };
    expect(await sendAPNsNotification(destination, { title: "Ready", body: "Done" })).toEqual({ sent: true });
    expect(authority).toBe("https://api.sandbox.push.apple.com");
    expect(lastHeaders).toMatchObject({ ":method": "POST", ":path": `/3/device/${destination.device_token}`, "apns-topic": "chat.lumiverse.ios", "apns-push-type": "alert", "apns-priority": "10" });
    expect(lastHeaders.authorization).toMatch(/^bearer /);
    expect(JSON.parse(lastPayload)).toHaveProperty("serverOrigin", destination.server_origin);
    expect(await sendAPNsNotification({ ...destination, id: "phone-1" }, { title: "Lumi", body: "Hello",
      data: { chatId: "chat-1", characterName: "Lumi" }, icon: "/api/v1/characters/char-1/avatar?size=sm" })).toEqual({ sent: true });
    const enriched = JSON.parse(lastPayload);
    const avatar = new URL(enriched.communication.avatarPath, destination.server_origin);
    const { verifyIOSNotificationAvatarPath } = await import("./ios-notification-avatar");
    expect(verifyIOSNotificationAvatarPath("phone-1", "char-1", avatar.searchParams.get("expires")!, avatar.searchParams.get("signature")!)).toBe(true);
    expect(enriched.aps["mutable-content"]).toBe(1);
    responseStatus = 410; responseBody = JSON.stringify({ reason: "Unregistered", timestamp: 1234567890000 });
    expect(await sendAPNsNotification({ ...destination, environment: "production" }, { title: "Ready", body: "Done" }))
      .toEqual({ sent: false, invalidatedAt: 1234567890000 });
    expect(authority).toBe("https://api.push.apple.com");
    const before = requestCount;
    expect(await sendAPNsNotification({ ...destination, bundle_id: "another.app" }, { title: "Ready", body: "Done" })).toEqual({ sent: false });
    expect(requestCount).toBe(before);
  });
});
