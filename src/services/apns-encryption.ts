import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getEncryptionKeyBytes } from "../crypto/init";

export interface IOSNotificationEncryption { key: string; keyId: string }
export interface EncryptedAPNsEnvelope { version: 1; keyId: string; nonce: string; ciphertext: string; tag: string }
export function validateIOSNotificationEncryption(value: unknown): IOSNotificationEncryption {
  const input = value as Partial<IOSNotificationEncryption> | null;
  if (!input || typeof input.key !== "string" || typeof input.keyId !== "string"
    || !/^[a-f0-9]{32}$/.test(input.keyId) || !/^[A-Za-z0-9+/]{43}=$/.test(input.key)) throw new Error("Invalid iOS notification encryption key");
  const key = Buffer.from(input.key, "base64");
  if (key.length !== 32 || key.toString("base64") !== input.key
    || createHash("sha256").update(key).digest("hex").slice(0, 32) !== input.keyId) throw new Error("Invalid iOS notification encryption key");
  return { key: input.key, keyId: input.keyId };
}
export function encryptAPNsPayload(payload: string, encryption: IOSNotificationEncryption, bundleId: string, environment: string): EncryptedAPNsEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(encryption.key, "base64"), nonce);
  cipher.setAAD(Buffer.from(`lumiverse-apns:v1:${bundleId}:${environment}:${encryption.keyId}`));
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return { version: 1, keyId: encryption.keyId, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
export function encryptedAPNsPayload(encrypted: EncryptedAPNsEnvelope): string {
  return JSON.stringify({ aps: { alert: { title: "Lumiverse", body: "You have a new notification." }, "mutable-content": 1, sound: "default" }, encrypted });
}
/** Protect relay credentials and content keys with the backend's existing identity. */
export function sealIOSNotificationSecret(value: string | undefined, context: string): string | null {
  if (!value) return null;
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", getEncryptionKeyBytes(), nonce);
  cipher.setAAD(Buffer.from(context));
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return "lvns1:" + Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString("base64");
}
export function openIOSNotificationSecret(value: string, context: string): string {
  if (!value.startsWith("lvns1:")) throw new Error("Invalid stored notification secret");
  const bytes = Buffer.from(value.slice(6), "base64");
  const cipher = createDecipheriv("aes-256-gcm", getEncryptionKeyBytes(), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28)); cipher.setAAD(Buffer.from(context));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
}
