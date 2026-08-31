import { describe, expect, test } from "bun:test";
import { canUsePromptAssemblyWorker } from "./prompt-assembly-worker-client";

describe("prompt assembly worker admission", () => {
  test("keeps the Response path in-process when the worker is disabled", () => {
    const previous = process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
    process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER = "false";
    try {
      expect(canUsePromptAssemblyWorker()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
      else process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER = previous;
    }
  });
});
