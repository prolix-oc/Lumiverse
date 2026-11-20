import { expect, mock, test } from "bun:test";
import { createHash, createDecipheriv } from "node:crypto";
mock.module("../crypto/init", () => ({ getEncryptionKeyBytes: () => new Uint8Array(32).fill(41) }));
const { encryptAPNsPayload, encryptedAPNsPayload, validateIOSNotificationEncryption, sealIOSNotificationSecret, openIOSNotificationSecret } = await import("./apns-encryption");
test("notification encryption binds the key and app/environment and never exposes alert content outside ciphertext", () => {
  const key = Buffer.alloc(32, 23), keyId = createHash("sha256").update(key).digest("hex").slice(0, 32);
  const config = validateIOSNotificationEncryption({ key: key.toString("base64"), keyId });
  const clear = JSON.stringify({ aps: { alert: { title: "Private name", body: "Private message" } }, serverOrigin: "https://private.example" });
  const envelope = encryptAPNsPayload(clear, config, "chat.lumiverse.ios", "production");
  const outside = encryptedAPNsPayload(envelope);
  for (const privateText of ["Private name", "Private message", "private.example", config.key]) expect(outside).not.toContain(privateText);
  expect(encryptAPNsPayload(clear, config, "chat.lumiverse.ios", "production").nonce).not.toBe(envelope.nonce);
  const decrypt = (environment: string) => {
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
    cipher.setAAD(Buffer.from(`lumiverse-apns:v1:chat.lumiverse.ios:${environment}:${keyId}`));
    cipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, "base64")), cipher.final()]).toString("utf8");
  };
  expect(decrypt("production")).toBe(clear); expect(() => decrypt("development")).toThrow();
  expect(() => validateIOSNotificationEncryption({ key: config.key, keyId: "0".repeat(32) })).toThrow();
});
test("stored credentials and content keys are protected by the backend identity and destination context", () => {
  const value = "lvr_" + "a".repeat(43), stored = sealIOSNotificationSecret(value, "ios-relay:phone")!;
  expect(stored).not.toContain(value); expect(openIOSNotificationSecret(stored, "ios-relay:phone")).toBe(value);
  expect(() => openIOSNotificationSecret(stored, "ios-relay:other-phone")).toThrow();
  expect(() => openIOSNotificationSecret(value, "ios-relay:phone")).toThrow();
});
