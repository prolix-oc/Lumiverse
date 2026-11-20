import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform !== "win32")("Windows PowerShell 5.1 forwards native commands before stdin closes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-native-pipe-"));
  const fixture = join(directory, "child with spaces.ts");
  const system = join(process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR || "C:\\Windows", "System32");
  const args = ["--desktop", "", "C:\\data folder\\", 'embedded "quotes" and \\"', "Lumiverse 🌌"];
  const inputs = ['{"id":"defaults"}\n', '{"id":"setup","payload":"Unicode 🌌"}\r\n'];
  const token = "native-pipe-regression-token";
  let child: Bun.Subprocess | undefined;
  writeFileSync(fixture, `
    // Preserve a BOM as text so an unsolicited preamble cannot be hidden.
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let buffer = "";
    for await (const bytes of Bun.stdin.stream()) {
      buffer += decoder.decode(bytes, { stream: true });
      let end;
      while ((end = buffer.indexOf("\\n")) !== -1) {
        const input = buffer.slice(0, end + 1);
        buffer = buffer.slice(end + 1);
        await Bun.write(Bun.stdout, "\\x1e" + JSON.stringify({ args: process.argv.slice(2), input, token: process.env.LUMIVERSE_DESKTOP_CHANNEL_TOKEN }) + "\\n");
      }
    }
    await Bun.write(Bun.stderr, new Uint8Array([0, 255, 128, 13, 10]));
    process.exit(37);
  `);
  try {
    // Use the same Windows PowerShell executable as the bundled-server smoke
    // test. pwsh would miss the 5.1 ConvertFrom-Json array regression.
    const launched = Bun.spawn([
      join(system, "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      join(import.meta.dir, "windows-native-pipe-host.ps1"),
    ], {
      cwd: system,
      env: {
        ...process.env, PATH: "",
        LUMIVERSE_NATIVE_SMOKE_COMMAND: JSON.stringify([process.execPath, "--no-env-file", fixture, ...args]),
        LUMIVERSE_DESKTOP_CHANNEL_TOKEN: token,
      },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child = launched;
    const timer = setTimeout(() => launched.kill(), 15_000);
    try {
      const reader = launched.stdout.getReader();
      const decoder = new TextDecoder();
      const stderr = new Response(launched.stderr).bytes();
      let output = "";
      for (const input of inputs) {
        launched.stdin.write(input);
        await launched.stdin.flush();
        // Closing stdin here would flush .NET's buffer and hide the deadlock.
        while (!output.includes("\n")) {
          const { value, done } = await reader.read();
          expect(done).toBe(false);
          if (done) throw new Error("Native pipe host exited before replying");
          output += decoder.decode(value, { stream: true });
        }
        const end = output.indexOf("\n");
        expect(output.slice(0, end + 1)).toBe("\x1e" + JSON.stringify({ args, input, token }) + "\n");
        output = output.slice(end + 1);
        expect(launched.exitCode).toBeNull();
      }
      launched.stdin.end();
      expect((await reader.read()).done).toBe(true);
      expect(output).toBe("");
      expect(await launched.exited).toBe(37);
      expect(await stderr).toEqual(new Uint8Array([0, 255, 128, 13, 10]));
    } finally { clearTimeout(timer); }
  } finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
