import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as secretsSvc from "./secrets.service";
import { __test__ } from "./embeddings.service";

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

describe("embedding secret status", () => {
  test("writes each provider's key to its own secret slot", async () => {
    const put = spyOn(secretsSvc, "putSecret").mockResolvedValue(undefined);
    const remove = spyOn(secretsSvc, "deleteSecret").mockImplementation(() => false);
    spies.push(put, remove);

    await __test__.putEmbeddingSecret("profile-user", "nvidia-nim", "nim-key");

    expect(put).toHaveBeenCalledWith("profile-user", "embedding_api_key_nvidia-nim", "nim-key");
    expect(remove).toHaveBeenCalledWith("profile-user", "embedding_api_key");
  });

  test("treats an unreadable API key as missing", async () => {
    spies.push(
      spyOn(secretsSvc, "getSecretForStatus").mockResolvedValue(null),
    );

    await expect(__test__.hasEmbeddingSecret("broken-secret-user", "openai-compatible")).resolves.toBe(false);
  });

  test("does not hide unrelated secret-store failures", async () => {
    spies.push(spyOn(secretsSvc, "getSecretForStatus").mockRejectedValue(new Error("database is locked")));

    await expect(
      __test__.hasEmbeddingSecret("database-error-user", "openai-compatible"),
    ).rejects.toThrow("database is locked");
  });
});
