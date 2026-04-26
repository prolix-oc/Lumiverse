import { describe, expect, test } from "bun:test";
import { SSRFError, validateHost } from "./safe-fetch";

describe("validateHost loopback allowance", () => {
  test("allows loopback IP literals when explicitly enabled", async () => {
    await expect(validateHost("127.0.0.1", { allowLoopback: true })).resolves.toBeUndefined();
    await expect(validateHost("::1", { allowLoopback: true })).resolves.toBeUndefined();
  });

  test("keeps loopback blocked by default", async () => {
    await expect(validateHost("127.0.0.1")).rejects.toBeInstanceOf(SSRFError);
  });

  test("does not allow broader private ranges", async () => {
    await expect(validateHost("192.168.1.10", { allowLoopback: true })).rejects.toBeInstanceOf(SSRFError);
    await expect(validateHost("10.0.0.5", { allowLoopback: true })).rejects.toBeInstanceOf(SSRFError);
    await expect(validateHost("169.254.169.254", { allowLoopback: true })).rejects.toBeInstanceOf(SSRFError);
  });
});
