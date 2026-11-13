import { expect, test } from "bun:test";
import { getFCMRoute, DEFAULT_FCM_RELAY_URL } from "./fcm-routing";

test("official builds default to the relay without requiring operator Firebase secrets", () => {
  expect(getFCMRoute({})).toMatchObject({ configured: true, delivery: "relay", projectId: "lumiverse-bc911",
    packageName: "chat.lumiverse.prototype", relayUrl: DEFAULT_FCM_RELAY_URL, encryptionRequired: true });
});
test("explicit invalid direct configuration and invalid relay origins never fall back", () => {
  expect(getFCMRoute({ FCM_SERVICE_ACCOUNT_PATH: "/missing/firebase.json" }).configured).toBe(false);
  expect(getFCMRoute({ FCM_DELIVERY_MODE: "direct" }).configured).toBe(false);
  expect(getFCMRoute({ FCM_DELIVERY_MODE: "disabled" }).configured).toBe(false);
  expect(getFCMRoute({ FCM_DELIVERY_MODE: "invalid" }).configured).toBe(false);
  for (const FCM_RELAY_URL of ["http://relay.test", "https://user:pass@relay.test", "https://relay.test/path", "https://relay.test/?token=secret"])
    expect(getFCMRoute({ FCM_RELAY_URL }).configured).toBe(false);
  expect(getFCMRoute({ FCM_DELIVERY_MODE: "relay", FCM_SERVICE_ACCOUNT_PATH: "/missing/firebase.json" }).delivery).toBe("relay");
});
