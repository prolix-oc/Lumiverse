import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { openIOSNotificationSecret, sealIOSNotificationSecret } from "./apns-encryption";

export const sealAndroidSecret = (value: string | undefined, context: string) => sealIOSNotificationSecret(value, `android:${context}`);
export const openAndroidSecret = (value: string, context: string) => openIOSNotificationSecret(value, `android:${context}`);
export interface AndroidEncryption { key: string; keyId: string }
export interface FCMEnvelope { version: 1; keyId: string; nonce: string; ciphertext: string; tag: string }
export interface FCMEncryptionContext { projectId: string; packageName: string; enrollmentId: string; serverOrigin: string; serverInstanceId: string }
export function validateAndroidEncryption(value: unknown): AndroidEncryption {
  const input = value as AndroidEncryption | null;
  if (!input || typeof input.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(input.key)
    || typeof input.keyId !== "string" || !/^[a-f0-9]{32}$/.test(input.keyId)) throw new Error("Invalid Android notification encryption key");
  const key = Buffer.from(input.key, "base64");
  if (key.length !== 32 || key.toString("base64") !== input.key || createHash("sha256").update(key).digest("hex").slice(0, 32) !== input.keyId)
    throw new Error("Invalid Android notification encryption key");
  return { key: input.key, keyId: input.keyId };
}
export function fcmAssociatedData(context: FCMEncryptionContext, keyId: string) {
  return JSON.stringify(["lumiverse-fcm", 1, context.projectId, context.packageName, context.enrollmentId,
    context.serverOrigin, context.serverInstanceId, keyId]);
}
export function encryptFCMPayload(notification: string, destinationId: string, accountId: string, encryption: AndroidEncryption,
  context: FCMEncryptionContext, now = Math.floor(Date.now() / 1000)): FCMEnvelope {
  const payload = JSON.parse(notification);
  const clear = { version: 1, messageId: randomBytes(16).toString("hex"), issuedAt: now, expiresAt: now + 3600,
    destinationId, accountId, serverOrigin: context.serverOrigin, serverInstanceId: context.serverInstanceId, notification: payload };
  while (Buffer.byteLength(JSON.stringify(clear)) > 2400) {
    if (payload.body) payload.body = Array.from(payload.body as string).slice(0, -32).join("");
    else if (payload.avatarPath || payload.tag || payload.data?.characterName) { delete payload.avatarPath; delete payload.tag; if (payload.data) payload.data.characterName = ""; }
    else if (payload.title) payload.title = Array.from(payload.title as string).slice(0, -16).join("");
    else throw new Error("Android notification routing context is too large");
  }
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(encryption.key, "base64"), nonce);
  cipher.setAAD(Buffer.from(fcmAssociatedData(context, encryption.keyId)));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(clear), "utf8"), cipher.final()]);
  return { version: 1, keyId: encryption.keyId, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
