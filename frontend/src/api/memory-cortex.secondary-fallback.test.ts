import { describe, expect, test } from "bun:test";
import {
  migrateSidecarIntoEndpointPairs,
  resolveCortexSidecarVisibility,
} from "./memory-cortex";

describe("frontend cortex secondary fallback helpers", () => {
  test("migrates sidecar.connectionProfileId/model into both primaries and preserves null secondary", () => {
    const migrated = migrateSidecarIntoEndpointPairs({
      connectionProfileId: "conn-1",
      model: "model-1",
    });
    expect(migrated.queryGeneration.primary).toEqual({
      connectionProfileId: "conn-1",
      model: "model-1",
    });
    expect(migrated.memorySummarization.primary).toEqual({
      connectionProfileId: "conn-1",
      model: "model-1",
    });
    expect(migrated.queryGeneration.secondary).toBeNull();
    expect(migrated.memorySummarization.secondary).toBeNull();
  });

  test("preserves an explicit secondary", () => {
    const migrated = migrateSidecarIntoEndpointPairs(
      { connectionProfileId: "conn-1", model: "model-1" },
      {
        primary: { connectionProfileId: "conn-1", model: "model-1" },
        secondary: { connectionProfileId: "conn-2", model: "model-2" },
      },
    );
    expect(migrated.queryGeneration.secondary).toEqual({
      connectionProfileId: "conn-2",
      model: "model-2",
    });
  });

  test("surfaces controlled unavailable and timeout states", () => {
    expect(resolveCortexSidecarVisibility({
      health: { availability: "unavailable", ready: false, connectivity: { attempted: false, success: null, message: "" } },
    })).toBe("unavailable");
    expect(resolveCortexSidecarVisibility({
      health: { availability: "ok", ready: true, connectivity: { attempted: true, success: false, message: "timeout", timedOut: true } },
    })).toBe("timeout");
    expect(resolveCortexSidecarVisibility({
      ingestion: { sidecarState: "timeout" },
    })).toBe("timeout");
    expect(resolveCortexSidecarVisibility({
      profileMissing: true,
    })).toBe("unavailable");
  });
});
