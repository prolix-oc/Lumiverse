import { describe, expect, test } from "bun:test";

describe("initializeSandbox", () => {
  test("blocks native fetch, including computed aliases, without changing the host runtime", () => {
    const hostFetch = globalThis.fetch;
    const hostBun = Bun;
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--eval", `
        import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";
        const originalVersion = Bun.version;
        let requests = 0;
        globalThis.fetch = () => { requests += 1; throw new Error("native fetch ran"); };

        initializeSandbox();
        initializeSandbox();

        const key = ["fet", "ch"].join("");
        const { fetch: request } = globalThis;
        for (const call of [
          () => fetch("https://example.com/script.js"),
          () => globalThis[key]("https://example.com/script.js"),
          () => request("https://example.com/script.js"),
        ]) {
          let blocked = false;
          try { call(); } catch (error) {
            blocked = error.message.includes("fetch is disabled") && error.message.includes("spindle.cors()");
          }
          if (!blocked) throw new Error("native fetch was not blocked");
        }
        if (requests !== 0) throw new Error("native fetch was reached");
        if (Reflect.set(globalThis, "fetch", () => {})) throw new Error("fetch is writable");
        if (Reflect.deleteProperty(globalThis, "fetch")) throw new Error("fetch is configurable");
        if (Reflect.defineProperty(globalThis, "fetch", { value: () => {} })) throw new Error("fetch can be replaced");
        if (Bun.version !== originalVersion) throw new Error("Bun metadata changed");
        if (!new Bun.Transpiler({ loader: "js" }).transformSync("const x = 1")) throw new Error("Bun.Transpiler changed");
      `],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(globalThis.fetch).toBe(hostFetch);
    expect(Bun).toBe(hostBun);
  });

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
