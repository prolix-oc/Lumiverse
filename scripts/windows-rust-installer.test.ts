import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  installRustForWindows,
  rustupWindowsArchitecture,
} from "./windows-rust-installer";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-rust-installer-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("rustupWindowsArchitecture", () => {
  test("maps every Rust-supported Windows architecture", () => {
    expect(rustupWindowsArchitecture("x64")).toBe("x86_64");
    expect(rustupWindowsArchitecture("arm64")).toBe("aarch64");
    expect(rustupWindowsArchitecture("ia32")).toBe("i686");
  });

  test("rejects unknown architectures", () => {
    expect(() => rustupWindowsArchitecture("mips")).toThrow("does not support");
  });
});

test("downloads, validates, and runs rustup before refreshing PATH", async () => {
  const root = tempRoot();
  const home = join(root, "home");
  const temporary = join(root, "temp");
  const env: Record<string, string | undefined> = { Path: "C:\\Windows\\System32" };
  const requested: string[] = [];
  const commands: string[][] = [];
  // MZ is the DOS/PE executable signature checked before execution.
  const executable = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);

  const result = await installRustForWindows({
    arch: "arm64",
    env,
    homeDir: home,
    tempDir: temporary,
    fetcher: async (input) => {
      requested.push(String(input));
      return new Response(executable, { status: 200 });
    },
    runCommand: async (command) => {
      commands.push(command);
      return 0;
    },
  });

  expect(requested).toEqual(["https://win.rustup.rs/aarch64"]);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.slice(1)).toEqual([
    "-y",
    "--profile",
    "minimal",
    "--default-toolchain",
    "stable",
  ]);
  expect(commands[0]?.[0]).toEndWith("rustup-init.exe");
  expect(result.cargoBin).toBe(join(home, ".cargo", "bin"));
  expect(env.Path?.split(delimiter)[0]).toBe(result.cargoBin);
  expect(readdirSync(temporary)).toEqual([]);
});

test("never executes a non-executable download", async () => {
  const root = tempRoot();
  let executed = false;

  await expect(installRustForWindows({
    arch: "x64",
    tempDir: root,
    fetcher: async () => new Response("proxy error", { status: 200 }),
    runCommand: async () => {
      executed = true;
      return 0;
    },
  })).rejects.toThrow("not a valid Windows executable");

  expect(executed).toBe(false);
  expect(readdirSync(root)).toEqual([]);
});

