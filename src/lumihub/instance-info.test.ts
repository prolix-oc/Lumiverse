import { describe, expect, test } from "bun:test";
import {
  createLumiHubInstanceInfo,
  LUMIHUB_PROTOCOL_VERSION,
  PRESET_REGEX_VERSIONING_CAPABILITY,
} from "./instance-info";

describe("LumiHub instance info", () => {
  test("reports backend and frontend versions independently with negotiated capabilities", () => {
    const info = createLumiHubInstanceInfo({
      backendVersion: "1.2.3",
      frontendVersion: "1.2.2",
    });

    expect(info).toMatchObject({
      version: "1.2.3",
      protocolVersion: LUMIHUB_PROTOCOL_VERSION,
      backendVersion: "1.2.3",
      frontendVersion: "1.2.2",
    });
    expect(info.capabilities).toContain("preset_import");
    expect(info.capabilities).toContain(PRESET_REGEX_VERSIONING_CAPABILITY);
  });
});
