import { describe, expect, test } from "bun:test";
import { describeTransportError } from "./provider-errors";

describe("describeTransportError", () => {
  test("explains Bun socket disconnects without exposing verbose fetch guidance", () => {
    const message = describeTransportError(
      new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ),
    );

    expect(message).toContain("provider connection closed");
    expect(message).toContain("network dropped the stream");
    expect(message).not.toContain("verbose");
  });

  test("uses Error.cause when fetch failed hides the transport detail", () => {
    const cause = new Error("connect ECONNRESET 127.0.0.1:8080");
    const message = describeTransportError(new Error("fetch failed", { cause }));

    expect(message).toBe("connect ECONNRESET 127.0.0.1:8080");
  });
});
