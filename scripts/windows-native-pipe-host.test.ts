import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform !== "win32")("Windows PowerShell 5.1 launches the native smoke command and forwards its pipes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-native-pipe-"));
  const fixture = join(directory, "child with spaces.ts");
  const system = join(process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR || "C:\\Windows", "System32");
  const args = ["--desktop", "", "C:\\data folder\\", 'embedded "quotes" and \\"', "Lumiverse 🌌"];
  const input = '\x1e{"id":"setup","payload":"Unicode 🌌"}\r\n';
  const token = "native-pipe-regression-token";
  let child: Bun.Subprocess | undefined;
  writeFileSync(fixture, `
    const input = await new Response(Bun.stdin.stream()).text();
    await Bun.write(Bun.stdout, "\\x1e" + JSON.stringify({ args: process.argv.slice(2), input, token: process.env.LUMIVERSE_DESKTOP_CHANNEL_TOKEN }) + "\\n");
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
      launched.stdin.write(input);
      launched.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(launched.stdout).text(), new Response(launched.stderr).bytes(), launched.exited,
      ]);
      expect({ exitCode, stdout }).toEqual({
        exitCode: 37,
        stdout: "\x1e" + JSON.stringify({ args, input, token }) + "\n",
      });
      expect(stderr).toEqual(new Uint8Array([0, 255, 128, 13, 10]));
    } finally { clearTimeout(timer); }
  } finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
