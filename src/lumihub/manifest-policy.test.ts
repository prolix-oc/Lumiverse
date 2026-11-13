import { describe, expect, test } from "bun:test";
import { selectLumiHubManifestEntries, type LumiHubManifestEntry } from "./manifest-policy";

const hubEntry: LumiHubManifestEntry = {
  slug: "lumihub/nyx",
  type: "character",
  name: "Nyx",
  creator: "LumiHub",
  source: "lumihub",
  installed_at: 1_721_000_000_000,
};

describe("LumiHub manifest policy", () => {
  test("sends only assets installed from LumiHub", () => {
    expect(selectLumiHubManifestEntries([
      hubEntry,
      { ...hubEntry, slug: "local/private-card", source: "local" },
      { ...hubEntry, slug: "chub/third-party-card", source: "chub" },
    ])).toEqual([hubEntry]);
  });
});
