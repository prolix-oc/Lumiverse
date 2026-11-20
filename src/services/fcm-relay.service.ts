import { validFCMRelayOrigin } from "./fcm-routing";
import type { FCMEnvelope } from "./fcm-encryption";

export const isFCMRelayCredential = (value: unknown): value is string => typeof value === "string" && /^lvf_[A-Za-z0-9_-]{43}$/.test(value);
export async function revokeFCMRelayDestination(url: string, credential: string) {
  if (!validFCMRelayOrigin(url) || !isFCMRelayCredential(credential)) return;
  const response = await fetch(url + "/v1/delivery", { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${credential}` } });
  await response.body?.cancel();
}
export async function sendFCMRelayNotification(url: string, credential: string, encrypted: FCMEnvelope, shouldSend = () => true): Promise<{ sent: boolean; invalidToken?: boolean }> {
  if (!validFCMRelayOrigin(url) || !isFCMRelayCredential(credential) || !shouldSend()) return { sent: false };
  const response = await fetch(url + "/v1/notifications", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, type: "alert", encrypted }) });
  if (!response.ok) { await response.body?.cancel(); return { sent: false }; }
  const reader = response.body?.getReader(); if (!reader) return { sent: false };
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 1024) { await reader.cancel(); return { sent: false }; } chunks.push(value); }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof result?.sent === "boolean" ? { sent: result.sent, ...(result.invalidToken === true ? { invalidToken: true } : {}) } : { sent: false };
  } catch { return { sent: false }; } finally { reader.releaseLock(); }
}
