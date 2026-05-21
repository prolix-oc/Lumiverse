import { describe, expect, test } from "bun:test";

describe("initializeSandbox", () => {
  test("preserves Function prototype helpers while blocking constructor use", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          const originalCall = Function.prototype.call;
          const originalApply = Function.prototype.apply;
          const originalBind = Function.prototype.bind;

          initializeSandbox();

          if (Function.prototype.call !== originalCall) throw new Error("call changed");
          if (Function.prototype.apply !== originalApply) throw new Error("apply changed");
          if (Function.prototype.bind !== originalBind) throw new Error("bind changed");

          let blocked = false;
          try {
            new Function("return 1");
          } catch (error) {
            blocked = error instanceof Error && error.message.includes("disabled");
          }
          if (!blocked) throw new Error("Function constructor was not blocked");

          blocked = false;
          try {
            Function.prototype.constructor("return 1");
          } catch (error) {
            blocked = error instanceof Error && error.message.includes("disabled");
          }
          if (!blocked) throw new Error("Function.prototype.constructor was not blocked");
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
});
