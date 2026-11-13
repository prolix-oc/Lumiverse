import { createHash, createHmac } from "node:crypto";
import type { IOSNotificationEncryption } from "./apns-encryption";

/** The renderer cannot read Keychain. Its static attributes carry only this
 * registration's key, derived locally from the native transport credential. */
export function spindleActivityEncryption(credentialHash: string, registrationId: string): IOSNotificationEncryption {
  const key = createHmac("sha256", Buffer.from(credentialHash, "hex"))
    .update(`lumiverse-spindle-activity:v1:${registrationId}`).digest();
  return { key: key.toString("base64"), keyId: createHash("sha256").update(key).digest("hex").slice(0, 32) };
}
