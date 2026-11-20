import { describe, expect, test } from "bun:test";
import {
  BETTER_AUTH_SSO_CALLBACK_PATH,
  EXTERNAL_SSO_CALLBACK_PATH,
  getExternalSsoCallbackPath,
  rewriteLegacySsoCallbackPath,
} from "./callback-compat";

describe("Better Auth callback compatibility", () => {
  test("rewrites the legacy provider callback to Better Auth 1.7's route", () => {
    expect(getExternalSsoCallbackPath("authentik"))
      .toBe(`${EXTERNAL_SSO_CALLBACK_PATH}/authentik`);
    expect(rewriteLegacySsoCallbackPath(getExternalSsoCallbackPath("authentik")))
      .toBe(`${BETTER_AUTH_SSO_CALLBACK_PATH}/authentik`);
  });

  test("leaves unrelated and malformed paths unchanged", () => {
    expect(rewriteLegacySsoCallbackPath("/api/auth/sign-in/social"))
      .toBe("/api/auth/sign-in/social");
    expect(rewriteLegacySsoCallbackPath(`${EXTERNAL_SSO_CALLBACK_PATH}/`))
      .toBe(`${EXTERNAL_SSO_CALLBACK_PATH}/`);
    expect(rewriteLegacySsoCallbackPath(`${EXTERNAL_SSO_CALLBACK_PATH}/one/two`))
      .toBe(`${EXTERNAL_SSO_CALLBACK_PATH}/one/two`);
  });
});
