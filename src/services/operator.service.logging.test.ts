import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { ProviderRequestError } from "../utils/provider-errors";

const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
let operatorService: typeof import("./operator.service").operatorService;

beforeAll(async () => {
  // Suppress terminal output while exercising the real console interception.
  for (const method of ["log", "info", "warn", "error"] as const) console[method] = () => {};
  ({ operatorService } = await import("./operator.service"));
});

afterAll(() => {
  operatorService?.cleanup();
  Object.assign(console, originalConsole);
});

describe("operator log capture", () => {
  test("keeps the sidecar's normal Error message, stack and nested transport cause", () => {
    const cause = Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
    const error = new Error("fetch failed", { cause });
    console.warn("[memory-cortex] Sidecar extraction failed, falling back to heuristic:", error);

    const entry = operatorService.getLogs(1)[0]!;
    expect(entry.source).toBe("stderr");
    expect(entry.text).toContain("Error: fetch failed");
    expect(entry.text).toContain("connection reset by peer");
    expect(entry.text).toContain("ECONNRESET");
    expect(entry.text).toContain("operator.service.logging.test.ts");
    expect(entry.text).not.toContain("\u001b[");
  });

  test("keeps HTTP provider diagnostics and errors nested in objects or aggregates", () => {
    const error = new ProviderRequestError({
      provider: "Custom", operation: "generate", status: 429, code: "rate_limited", detail: "Try again later",
    });
    console.error("sidecar failure", { failure: new AggregateError([error], "All endpoints failed") });

    const entry = operatorService.getLogs(1)[0]!;
    expect(entry.text).toContain("All endpoints failed");
    expect(entry.text).toContain("Custom generate failed (429): Try again later");
    expect(entry.text).toContain("rate_limited");
  });

  test("capturing cycles, bigint and throwing serialization hooks does not break the caller", () => {
    const value: Record<string, unknown> = { count: 3n, toJSON() { throw new Error("Do not serialize"); } };
    value.self = value;
    expect(() => console.warn("non-Error failure", value, undefined, null, Symbol("failure"))).not.toThrow();
    const entry = operatorService.getLogs(1)[0]!;
    expect(entry.text).toContain("3n");
    expect(entry.text).toContain("Circular");
    expect(entry.text).toContain("undefined null Symbol(failure)");
  });

  test("captures sidecar dispatch and response info in the operator history", () => {
    console.info("[memory-cortex] single → connection=test chunks=1");
    expect(operatorService.getLogs(1)[0]).toMatchObject({
      source: "stdout", text: "[memory-cortex] single → connection=test chunks=1",
    });
  });

  test("streams the same readable error that is retained in log history", async () => {
    const emit = spyOn(eventBus, "emit").mockImplementation(() => {});
    operatorService.subscribeLogs("operator-log-test");
    try {
      console.warn("stream test", new Error("upstream unavailable"));
      const entry = operatorService.getLogs(1)[0]!;
      await Bun.sleep(250);
      const call = emit.mock.calls.find(([event]) => event === EventType.OPERATOR_LOG);
      expect(call?.[1]).toEqual({ entries: [entry] });
      expect(call?.[2]).toBe("operator-log-test");
      expect(entry.text).toContain("Error: upstream unavailable");
    } finally {
      operatorService.unsubscribeLogs("operator-log-test");
      emit.mockRestore();
    }
  });
});
