import { afterEach, describe, expect, test } from "bun:test";
import {
  clearFrontendRuntimeCapabilities,
  getFrontendRuntimeCapabilities,
  isFrontendRuntimeCapability,
  registerFrontendRuntimeCapability,
  resetFrontendRuntimeCapabilitiesForTests,
  unregisterFrontendRuntimeCapability,
} from "./frontend-runtime-capabilities";

afterEach(() => {
  resetFrontendRuntimeCapabilitiesForTests();
});

describe("frontend runtime capabilities", () => {
  test("validates the supported capability set", () => {
    expect(isFrontendRuntimeCapability("message_tag_interceptor")).toBe(true);
    expect(isFrontendRuntimeCapability("unknown")).toBe(false);
  });

  test("registers idempotently and cleans up by extension", () => {
    registerFrontendRuntimeCapability("ext-1", "message_tag_interceptor");
    registerFrontendRuntimeCapability("ext-1", "message_tag_interceptor");
    expect(getFrontendRuntimeCapabilities("ext-1")).toEqual(["message_tag_interceptor"]);

    unregisterFrontendRuntimeCapability("ext-1", "message_tag_interceptor");
    expect(getFrontendRuntimeCapabilities("ext-1")).toEqual([]);

    registerFrontendRuntimeCapability("ext-1", "message_tag_interceptor");
    clearFrontendRuntimeCapabilities("ext-1");
    expect(getFrontendRuntimeCapabilities("ext-1")).toEqual([]);
  });
});
