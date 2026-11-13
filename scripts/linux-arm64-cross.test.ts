import { describe, expect, test } from "bun:test";
import { testExecutables, verifyArm64Elf } from "./linux-arm64-cross";

describe("ARM64 cross-build handoff", () => {
  test("rejects host binaries, malformed ELF and wrong byte order", () => {
    const elf = new Uint8Array(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf[18] = 0xb7;
    expect(() => verifyArm64Elf(elf)).not.toThrow();
    for (const [offset, value] of [[18, 0x3e], [4, 1], [5, 2], [0, 0]]) {
      const bad = elf.slice(); bad[offset!] = value!;
      expect(() => verifyArm64Elf(bad)).toThrow("ARM64 ELF");
    }
    expect(() => verifyArm64Elf(elf.slice(0, 20))).toThrow("ARM64 ELF");
  });

  test("selects only the application test executable from Cargo's artifact stream", () => {
    const artifact = { reason: "compiler-artifact", profile: { test: true }, target: { name: "lumiverse_tray_lib" }, executable: "/target/release/deps/app-tests" };
    const log = [artifact, { ...artifact, profile: { test: false }, executable: "/target/release/lumiverse-tray" }, { reason: "build-finished", success: true }].map(value => JSON.stringify(value)).join("\n");
    expect(testExecutables(log, "/target/release")).toEqual([artifact.executable]);
    for (const executable of ["/target/release-other/deps/test", "/target/release/deps/../../outside"]) {
      expect(() => testExecutables(JSON.stringify({ ...artifact, executable }), "/target/release")).toThrow("target directory");
    }
    expect(() => testExecutables("", "/target/release")).toThrow("one ARM64");
    expect(() => testExecutables([artifact, artifact].map(value => JSON.stringify(value)).join("\n"), "/target/release")).toThrow("one ARM64");
  });
});
