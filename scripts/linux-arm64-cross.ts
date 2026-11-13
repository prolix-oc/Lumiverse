#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const target = join(root, "desktop/src-tauri/target/aarch64-unknown-linux-gnu/release");
const testRecord = join(root, "desktop/src-tauri/target/arm64-test-executables.json");

export function verifyArm64Elf(bytes: Uint8Array): void {
  if (bytes.length < 64 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46
    || bytes[4] !== 2 || bytes[5] !== 1 || bytes[18] !== 0xb7 || bytes[19] !== 0) {
    throw new Error("Expected a little-endian ARM64 ELF executable");
  }
}

export function testExecutables(log: string, releaseRoot: string): string[] {
  const prefix = resolve(releaseRoot, "deps") + sep;
  const paths = log.split("\n").filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => entry.reason === "compiler-artifact" && entry.profile?.test
      && entry.target?.name === "lumiverse_tray_lib" && entry.executable)
    .map(entry => resolve(entry.executable as string));
  if (paths.length !== 1 || !paths[0]!.startsWith(prefix)) throw new Error("Expected one ARM64 application test executable in the target directory");
  return paths;
}

async function main() {
  switch (process.argv[2]) {
    case "record-tests": {
      const paths = testExecutables(await Bun.file(join(root, "desktop/src-tauri/target/arm64-tests.jsonl")).text(), target);
      for (const path of paths) verifyArm64Elf(readFileSync(path));
      await Bun.write(testRecord, JSON.stringify(paths));
      break;
    }
    case "run-tests": {
      if (process.arch !== "arm64") throw new Error("ARM64 tests must execute in the ARM64 runtime container");
      const paths: string[] = await Bun.file(testRecord).json();
      if (paths.length !== 1) throw new Error("Missing ARM64 test executable");
      for (const path of paths) {
        if (!realpathSync(path).startsWith(realpathSync(join(target, "deps")) + sep)) throw new Error("ARM64 test executable escapes the target directory");
        verifyArm64Elf(readFileSync(path));
        // QEMU can expose more guest CPUs than it can schedule smoothly. Keep
        // the test harness parallel, but avoid the default unbounded fan-out.
        const child = Bun.spawn([path, "--test-threads=2"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        if (await child.exited !== 0) throw new Error("ARM64 application tests failed");
      }
      break;
    }
    case "verify-app":
      verifyArm64Elf(readFileSync(join(target, "lumiverse-tray")));
      console.log("[arm64-cross] Verified ARM64 application compiled by native x64 Rust.");
      break;
    default: throw new Error("Expected record-tests, run-tests, or verify-app");
  }
}
if (import.meta.main) await main();
