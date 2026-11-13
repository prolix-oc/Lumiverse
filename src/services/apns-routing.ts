export const DEFAULT_APNS_RELAY_URL = "https://apn-relay.lumiverse.chat";
export const OFFICIAL_IOS_BUNDLE_ID = "chat.lumiverse.ios";
export type APNsDeliveryMode = "relay" | "direct";

/** Routing is selected by server policy and app identity, never by a failed send. */
export function getAPNsRoute(bundleId?: string, env: NodeJS.ProcessEnv = process.env): {
  mode: APNsDeliveryMode | null; bundleId: string; relayUrl: string; reason: string | null;
} {
  const selected = bundleId || env.APNS_BUNDLE_ID || OFFICIAL_IOS_BUNDLE_ID;
  const policy = env.APNS_DELIVERY_MODE || "auto";
  const directBundle = env.APNS_BUNDLE_ID || OFFICIAL_IOS_BUNDLE_ID;
  const hasDirect = !!(env.APNS_CERTIFICATE_PATH || env.APNS_PRIVATE_KEY_PATH);
  const relayBundle = env.APNS_RELAY_BUNDLE_ID || OFFICIAL_IOS_BUNDLE_ID;
  const relayUrl = env.APNS_RELAY_URL || DEFAULT_APNS_RELAY_URL;
  const result = (mode: APNsDeliveryMode | null, reason: string | null = null) => ({ mode, bundleId: selected, relayUrl, reason });
  if (typeof selected !== "string" || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(selected))
    return result(null, "Invalid iOS app bundle ID.");
  if (policy === "disabled") return result(null, "iOS notifications are disabled on this server.");
  if (!["auto", "relay", "direct"].includes(policy)) return result(null, "Invalid APNS_DELIVERY_MODE server setting.");
  if (policy === "direct" || (policy === "auto" && hasDirect && selected === directBundle)) {
    return selected === directBundle ? result("direct") : result(null, "The app bundle ID does not match this server's direct APNs configuration.");
  }
  if (selected !== relayBundle) return result(null, "This app needs matching direct APNs credentials or a relay configured for its signing team.");
  try {
    const url = new URL(relayUrl);
    if ((url.protocol !== "https:" && !(env.NODE_ENV === "test" && url.protocol === "http:" && url.hostname === "127.0.0.1"))
      || url.origin !== relayUrl || url.username || url.password) throw new Error();
  } catch { return result(null, "Invalid APNS_RELAY_URL server setting; use an HTTPS origin."); }
  return result("relay");
}
