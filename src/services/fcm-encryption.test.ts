import { expect, test } from "bun:test";
import { createDecipheriv, createHash } from "node:crypto";
import { encryptFCMPayload, fcmAssociatedData, validateAndroidEncryption } from "./fcm-encryption";
import { boundedAndroidPayload } from "./fcm.service";

test("Android envelopes authenticate routing, hide content, and fit the FCM data limit", () => {
  const key = Buffer.alloc(32, 9), encryption = validateAndroidEncryption({ key: key.toString("base64"), keyId: createHash("sha256").update(key).digest("hex").slice(0, 32) });
  const context = { projectId: "lumiverse-bc911", packageName: "chat.lumiverse.prototype", enrollmentId: "e".repeat(43),
    serverOrigin: "https://chat.example", serverInstanceId: "lvdi_" + "s".repeat(32) };
  const notification = boundedAndroidPayload({ title: "Alice", body: "Secret 🦊".repeat(500), data: { chatId: "chat-1" } });
  const envelope = encryptFCMPayload(notification, "destination", "owner", encryption, context, 1000);
  expect(JSON.stringify(envelope)).not.toContain("Secret");
  expect(Buffer.byteLength(JSON.stringify({ lvEncrypted: JSON.stringify(envelope), enrollmentId: context.enrollmentId }))).toBeLessThanOrEqual(3800);
  const open = (origin: string) => {
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
    cipher.setAAD(Buffer.from(fcmAssociatedData({ ...context, serverOrigin: origin }, encryption.keyId)));
    cipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, "base64")), cipher.final()]).toString());
  };
  expect(open(context.serverOrigin)).toMatchObject({ version: 1, issuedAt: 1000, expiresAt: 4600, destinationId: "destination", accountId: "owner", notification: { title: "Alice" } });
  expect(() => open("https://another.example")).toThrow();
  expect(encryptFCMPayload(notification, "destination", "owner", encryption, context).nonce).not.toBe(envelope.nonce);
  expect(() => validateAndroidEncryption({ ...encryption, keyId: "0".repeat(32) })).toThrow();
});
