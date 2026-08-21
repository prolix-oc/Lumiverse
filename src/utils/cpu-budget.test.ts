import { describe, expect, test } from "bun:test";
import {
  currentWorkerBudget,
  deriveWorkerBudget,
  logicalThreadCount,
  setWorkerBudgetOverride,
} from "./cpu-budget";

describe("cpu-budget", () => {
  test("logicalThreadCount floors and floors invalid values to 1", () => {
    expect(logicalThreadCount(() => 14)).toBe(14);
    expect(logicalThreadCount(() => 1.9)).toBe(1);
    expect(logicalThreadCount(() => 0)).toBe(1);
    expect(logicalThreadCount(() => Number.NaN)).toBe(1);
    expect(logicalThreadCount(() => { throw new Error("unavailable"); })).toBe(1);
  });

  test("reserves threads and scales Sharp past the laptop cap on big hosts", () => {
    expect(deriveWorkerBudget(14)).toEqual({
      logicalThreads: 14,
      reserved: 2,
      workerConcurrency: 6,
      sharpConcurrency: 4,
      deferredImageConcurrency: 2,
    });
    expect(deriveWorkerBudget(8)).toEqual({
      logicalThreads: 8,
      reserved: 2,
      workerConcurrency: 6,
      sharpConcurrency: 4,
      deferredImageConcurrency: 2,
    });
    expect(deriveWorkerBudget(4)).toEqual({
      logicalThreads: 4,
      reserved: 2,
      workerConcurrency: 2,
      sharpConcurrency: 2,
      deferredImageConcurrency: 1,
    });
    expect(deriveWorkerBudget(2)).toEqual({
      logicalThreads: 2,
      reserved: 1,
      workerConcurrency: 1,
      sharpConcurrency: 1,
      deferredImageConcurrency: 1,
    });
    expect(deriveWorkerBudget(1)).toEqual({
      logicalThreads: 1,
      reserved: 0,
      workerConcurrency: 1,
      sharpConcurrency: 1,
      deferredImageConcurrency: 1,
    });
    expect(deriveWorkerBudget(36)).toEqual({
      logicalThreads: 36,
      reserved: 4,
      workerConcurrency: 8,
      sharpConcurrency: 10,
      deferredImageConcurrency: 4,
    });
    expect(deriveWorkerBudget(72)).toEqual({
      logicalThreads: 72,
      reserved: 9,
      workerConcurrency: 15,
      sharpConcurrency: 21,
      deferredImageConcurrency: 8,
    });
  });

  test("override replaces the live budget until cleared", () => {
    const override = deriveWorkerBudget(4);
    setWorkerBudgetOverride(override);
    expect(currentWorkerBudget()).toEqual(override);
    setWorkerBudgetOverride(null);
    expect(currentWorkerBudget().logicalThreads).toBeGreaterThanOrEqual(1);
  });
});
