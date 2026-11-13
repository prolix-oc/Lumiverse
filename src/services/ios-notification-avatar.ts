import { createHmac, timingSafeEqual } from "node:crypto";
import { getEncryptionKeyBytes } from "../crypto/init";

const MAX_LIFETIME_SECONDS = 65 * 60;
const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);

function signature(destinationId: string, characterId: string, expires: number): Buffer {
  return createHmac("sha256", getEncryptionKeyBytes())
    .update(JSON.stringify(["lumiverse-ios-avatar-v1", destinationId, characterId, expires])).digest();
}

export function issueIOSNotificationAvatarPath(destinationId: string, characterId: string, now = Math.floor(Date.now() / 1000)): string {
  if (!validId(destinationId) || !validId(characterId)) throw new Error("Invalid notification avatar identifier");
  const expires = now + MAX_LIFETIME_SECONDS;
  const proof = signature(destinationId, characterId, expires).toString("base64url");
  return `/api/ios-notifications/v1/avatar/${destinationId}/${characterId}?expires=${expires}&signature=${proof}`;
}

export function verifyIOSNotificationAvatarPath(destinationId: string, characterId: string,
  rawExpires: string | undefined, proof: string | undefined, now = Math.floor(Date.now() / 1000)): boolean {
  if (!validId(destinationId) || !validId(characterId) || !/^\d{1,12}$/.test(rawExpires ?? "")
    || !/^[A-Za-z0-9_-]{43}$/.test(proof ?? "")) return false;
  const expires = Number(rawExpires);
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + MAX_LIFETIME_SECONDS) return false;
  const expected = signature(destinationId, characterId, expires);
  const received = Buffer.from(proof!, "base64url");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
