import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as secretsSvc from "./secrets.service";
import { withReadableApiKeyStatus, withReadableApiKeyStatuses } from "./connection-secret-status";

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

describe("connection API-key status", () => {
  test("downgrades a persisted key flag when the credential is unreadable", async () => {
    spies.push(spyOn(secretsSvc, "getSecretForStatus").mockResolvedValue(null));

    await expect(withReadableApiKeyStatus(
      "user-1",
      { id: "connection-1", has_api_key: true, name: "Primary" },
      (id) => `connection_${id}_api_key`,
    )).resolves.toEqual({ id: "connection-1", has_api_key: false, name: "Primary" });
  });

  test("does not read the secret when the persisted flag is already false", async () => {
    const read = spyOn(secretsSvc, "getSecretForStatus").mockResolvedValue("unexpected");
    spies.push(read);

    const profile = { id: "connection-1", has_api_key: false };
    await expect(withReadableApiKeyStatus("user-1", profile, (id) => id)).resolves.toBe(profile);
    expect(read).not.toHaveBeenCalled();
  });

  test("preserves pagination metadata while reconciling every profile", async () => {
    spies.push(
      spyOn(secretsSvc, "getSecretForStatus").mockImplementation(async (_userId, key) => (
        key.includes("readable") ? "key" : null
      )),
    );

    const result = await withReadableApiKeyStatuses(
      "user-1",
      {
        data: [
          { id: "readable", has_api_key: true },
          { id: "broken", has_api_key: true },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      },
      (id) => `connection_${id}`,
    );

    expect(result.data.map((profile) => profile.has_api_key)).toEqual([true, false]);
    expect({ total: result.total, limit: result.limit, offset: result.offset }).toEqual({
      total: 2,
      limit: 20,
      offset: 0,
    });
  });
});
