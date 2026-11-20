import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  SecretDecryptionError,
  __test__,
  isSecretDecryptionError,
  isSecretDecryptionFailure,
} from "./secrets.service";

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

describe("secret decryption recovery", () => {
  test("wraps WebCrypto authentication failures with an actionable runtime error", () => {
    const operationError = new DOMException(
      "The operation failed for an operation-specific reason",
      "OperationError",
    );
    const normalized = __test__.normalizeSecretReadError(operationError, "connection_api_key");

    expect(normalized).toBeInstanceOf(SecretDecryptionError);
    expect(isSecretDecryptionError(normalized)).toBe(true);
    expect((normalized as Error).message).toContain("cannot be decrypted");
    expect((normalized as Error).message).toContain("replace the credential in Settings");
  });

  test("treats unreadable status credentials as missing and warns only once", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    spies.push(warn);
    const read = () => Promise.reject(
      new DOMException("The operation failed for an operation-specific reason", "OperationError"),
    );

    await expect(
      __test__.recoverUnreadableSecretForStatus("broken-user", "connection_api_key", read),
    ).resolves.toBeNull();
    await expect(
      __test__.recoverUnreadableSecretForStatus("broken-user", "connection_api_key", read),
    ).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("Treating it as missing");
  });

  test("does not hide unrelated secret-store failures", async () => {
    await expect(
      __test__.recoverUnreadableSecretForStatus(
        "database-error-user",
        "connection_api_key",
        () => Promise.reject(new Error("database is locked")),
      ),
    ).rejects.toThrow("database is locked");
  });

  test("only recognizes WebCrypto decryption failure shapes", () => {
    expect(isSecretDecryptionFailure(new DOMException("failed", "OperationError"))).toBe(true);
    expect(isSecretDecryptionFailure(new DOMException("invalid", "DataError"))).toBe(true);
    expect(isSecretDecryptionFailure(new DOMException("timed out", "AbortError"))).toBe(false);
    expect(isSecretDecryptionFailure(new Error("OperationError"))).toBe(false);
  });
});
