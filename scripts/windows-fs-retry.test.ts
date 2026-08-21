import { describe, expect, test } from "bun:test";
import { retryWindowsRename, WINDOWS_RENAME_RETRY_ATTEMPTS } from "./windows-fs-retry";

function windowsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("retryWindowsRename", () => {
  test("retries transient Windows lock errors with bounded backoff", async () => {
    let calls = 0;
    const delays: number[] = [];

    await expect(retryWindowsRename(() => {
      calls += 1;
      if (calls < 4) throw windowsError("EBUSY");
      return "promoted";
    }, {
      platform: "win32",
      sleep: async (delay) => { delays.push(delay); },
    })).resolves.toBe("promoted");

    expect(calls).toBe(4);
    expect(delays).toEqual([50, 100, 200]);
  });

  test("does not retry on non-Windows platforms or permanent errors", async () => {
    let posixCalls = 0;
    await expect(retryWindowsRename(() => {
      posixCalls += 1;
      throw windowsError("EBUSY");
    }, { platform: "darwin" })).rejects.toMatchObject({ code: "EBUSY" });
    expect(posixCalls).toBe(1);

    let permanentCalls = 0;
    await expect(retryWindowsRename(() => {
      permanentCalls += 1;
      throw windowsError("ENOENT");
    }, { platform: "win32" })).rejects.toMatchObject({ code: "ENOENT" });
    expect(permanentCalls).toBe(1);
  });

  test("stops after a bounded number of attempts", async () => {
    let calls = 0;
    await expect(retryWindowsRename(() => {
      calls += 1;
      throw windowsError("EPERM");
    }, {
      platform: "win32",
      sleep: async () => {},
    })).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(WINDOWS_RENAME_RETRY_ATTEMPTS);
  });
});
