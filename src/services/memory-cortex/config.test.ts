import { expect, test } from "bun:test";
import { isCortexEnabledForChat } from "./config";

test("chat Cortex opt-out inherits global config unless explicitly disabled", () => {
  expect(isCortexEnabledForChat({ enabled: true }, {})).toBe(true);
  expect(isCortexEnabledForChat({ enabled: true }, { cortex_settings: {} })).toBe(true);
  expect(isCortexEnabledForChat({ enabled: true }, { cortex_settings: { enabled: false } })).toBe(false);
  expect(isCortexEnabledForChat({ enabled: true }, { cortex_settings: { enabled: true } })).toBe(true);
  expect(isCortexEnabledForChat({ enabled: false }, { cortex_settings: { enabled: true } })).toBe(false);
});
