import { getAPNsRoute } from "./apns-routing";
import type { APNsDelivery } from "./apns.service";

export const isAPNsRelayCredential = (value: unknown): value is string => typeof value === "string" && /^lvr_[A-Za-z0-9_-]{43}$/.test(value);
export async function revokeAPNsRelayDestination(bundleId: string, credential: string): Promise<void> {
  const route = getAPNsRoute(bundleId);
  if (route.mode !== "relay" || !isAPNsRelayCredential(credential)) return;
  const response = await fetch(route.relayUrl + "/v1/delivery", { method: "DELETE", redirect: "error",
    signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${credential}` } });
  await response.body?.cancel();
}
export async function sendAPNsRelayNotification(bundleId: string, credential: string, payload: Record<string, unknown>): Promise<APNsDelivery> {
  const route = getAPNsRoute(bundleId);
  if (route.mode !== "relay" || !isAPNsRelayCredential(credential)) return { sent: false };
  const response = await fetch(route.relayUrl + "/v1/notifications", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` }, body: JSON.stringify(payload),
  });
  if (!response.ok) { await response.body?.cancel(); return { sent: false }; }
  const reader = response.body?.getReader();
  if (!reader) return { sent: false };
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024) { await reader.cancel(); return { sent: false }; }
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result.sent !== "boolean") return { sent: false };
    return { sent: result.sent,
      ...(result.invalidToken === true ? { invalidToken: true } : {}),
      ...(typeof result.invalidatedAt === "number" && Number.isFinite(result.invalidatedAt) && result.invalidatedAt > 0
        ? { invalidatedAt: result.invalidatedAt } : {}) };
  } catch { return { sent: false }; } finally { reader.releaseLock(); }
}
