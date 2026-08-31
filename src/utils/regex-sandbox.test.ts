import { expect, test } from "bun:test";
import { regexReplaceSandboxed, shutdownRegexSandbox } from "./regex-sandbox";

test("invalid regex syntax is compiled inside the terminable isolate", async () => {
  const hostRegExp = globalThis.RegExp;
  let hostCompileCount = 0;
  globalThis.RegExp = new Proxy(hostRegExp, {
    construct(target, args, newTarget) {
      hostCompileCount++;
      return Reflect.construct(target, args, newTarget);
    },
  });

  try {
    let rejected = false;
    try {
      await regexReplaceSandboxed("[", "g", "input", "");
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(hostCompileCount).toBe(0);
  } finally {
    globalThis.RegExp = hostRegExp;
    await shutdownRegexSandbox();
  }
});
