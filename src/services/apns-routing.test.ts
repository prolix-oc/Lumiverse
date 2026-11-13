import { expect, test } from "bun:test";
import { getAPNsRoute, DEFAULT_APNS_RELAY_URL } from "./apns-routing";

test("defaults official IPAs to the relay and preserves configured direct credentials", () => {
  expect(getAPNsRoute(undefined, {})).toMatchObject({ mode: "relay", bundleId: "chat.lumiverse.ios", relayUrl: DEFAULT_APNS_RELAY_URL });
  const env = { APNS_PRIVATE_KEY_PATH: "/secrets/key.p8", APNS_BUNDLE_ID: "chat.example.custom" };
  expect(getAPNsRoute("chat.example.custom", env).mode).toBe("direct");
  expect(getAPNsRoute("chat.lumiverse.ios", env).mode).toBe("relay");
  expect(getAPNsRoute("chat.example.other", env).mode).toBeNull();
  expect(getAPNsRoute("chat.lumiverse.ios", { ...env, APNS_DELIVERY_MODE: "direct" }).mode).toBeNull();
});
test("explicit policy fails closed and relay configuration cannot carry credentials or redirects", () => {
  for (const APNS_DELIVERY_MODE of ["disabled", "unknown"]) expect(getAPNsRoute(undefined, { APNS_DELIVERY_MODE }).mode).toBeNull();
  for (const APNS_RELAY_URL of ["http://relay.test", "https://user:password@relay.test", "https://relay.test/path", "https://relay.test/?target=evil"])
    expect(getAPNsRoute(undefined, { APNS_RELAY_URL }).mode).toBeNull();
  expect(getAPNsRoute(undefined, { APNS_DELIVERY_MODE: "relay", APNS_PRIVATE_KEY_PATH: "/secrets/key.p8" }).mode).toBe("relay");
  expect(getAPNsRoute("__proto__", {}).mode).toBeNull();
});
