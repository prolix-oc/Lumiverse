import { afterEach, describe, expect, test } from "bun:test";

import {
  clearUserExtensionSettingsTabs,
  getUserExtensionSettingsTabs,
  setUserExtensionSettingsTabs,
} from "./ui-frontend-state.service";
import { getVisibleSettingsTabs } from "./ui-registry";

const USER_ID = "h5-settings-tab-test-user";

afterEach(() => {
  clearUserExtensionSettingsTabs(USER_ID);
});

function tab(
  registrationId: string,
  extensionId: string,
  tabId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    registrationId,
    extensionId,
    tabId,
    tabName: `${tabId} ${registrationId}`,
    keywords: [registrationId],
    order: 100,
    sequence: 1,
    ...overrides,
  };
}

describe("backend settings-tab snapshot", () => {
  test("sanitizes snapshots and enforces four-per-extension and thirty-two-global caps", () => {
    const snapshot = [
      tab("invalid", "extension.invalid", ""),
      ...Array.from({ length: 5 }, (_, index) => tab(
        `same-${index}`,
        "extension.same",
        `same-${index}`,
      )),
      ...Array.from({ length: 28 }, (_, index) => tab(
        `global-${index}`,
        `extension.global-${index}`,
        `global-${index}`,
      )),
      tab("same-0", "extension.duplicate", "duplicate"),
    ];

    setUserExtensionSettingsTabs(USER_ID, snapshot);
    const stored = getUserExtensionSettingsTabs(USER_ID);

    expect(stored).toHaveLength(32);
    expect(stored.filter((entry) => entry.extensionId === "extension.same")).toHaveLength(4);
    expect(stored.some((entry) => entry.registrationId === "same-4")).toBe(false);
    expect(stored.some((entry) => entry.registrationId === "invalid")).toBe(false);
    expect(stored.every((entry) => entry.extensionId !== "extension.duplicate")).toBe(true);
  });

  test("mirrors one shared navigation entry while preserving core role authority", () => {
    setUserExtensionSettingsTabs(USER_ID, [
      tab("core-claim", "extension.core", "account", {
        tabName: "Extension account",
        keywords: ["extension-account"],
        sequence: 1,
      }),
      tab("dynamic-later", "extension.later", "productivity", {
        tabName: "Later productivity",
        keywords: ["later"],
        order: 0,
        sequence: 3,
      }),
      tab("dynamic-owner", "extension.owner", "productivity", {
        tabName: "Productivity",
        iconSvg: "<svg data-owner=\"owner\" />",
        keywords: ["productivity"],
        order: 20,
        sequence: 2,
      }),
      tab("hidden-operator", "extension.member", "operator", {
        tabName: "Injected operator",
        sequence: 0,
      }),
    ]);

    const memberTabs = getVisibleSettingsTabs("member", USER_ID);
    const account = memberTabs.find((entry) => entry.id === "account");
    const productivity = memberTabs.filter((entry) => entry.id === "productivity");

    expect(account).toMatchObject({
      tabName: "Account Settings",
      keywords: expect.arrayContaining(["account", "extension-account"]),
    });
    expect(productivity).toHaveLength(1);
    expect(productivity[0]).toMatchObject({
      tabName: "Productivity",
      iconSvg: "<svg data-owner=\"owner\" />",
      keywords: expect.arrayContaining(["productivity", "later"]),
    });
    expect(memberTabs.some((entry) => entry.id === "operator")).toBe(false);
  });
});
