import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const compiled of [false, true]) {
  test(`desktop callbacks and parent disconnect through ${compiled ? "compiled" : "interpreted"} native pipes`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "lumiverse-desktop-channel-"));
    const token = "desktop-channel-regression-token";
    const defaults = { format: 1, dataDir: join(directory, "data 🌌"), port: 7860, host: "127.0.0.1" };
    const fixture = join(directory, "desktop.ts");
    writeFileSync(fixture, `
      import { BundleDesktopChannel } from ${JSON.stringify(resolve(import.meta.dir, "bundle-desktop.ts"))};
      const channel = new BundleDesktopChannel(${JSON.stringify(defaults)}, {branch:"staging",version:"test"} as any,
        async () => {}, () => process.exit(0));
      channel.needsSetup();
      await channel.configuration;
    `);
    const binary = join(directory, process.platform === "win32" ? "desktop.exe" : "desktop");
    let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const windowsSystem = join(process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR || "C:\\Windows", "System32");
    const kill = () => {
      if (!child || child.exitCode !== null) return;
      if (process.platform === "win32") Bun.spawnSync([join(windowsSystem, "taskkill.exe"), "/PID", String(child.pid), "/T", "/F"], {stdout:"ignore",stderr:"ignore"});
      else child.kill();
    };
    try {
      if (compiled) {
        const result = await Bun.build({ entrypoints: [fixture], minify: true,
          compile: { outfile: binary, autoloadDotenv: false, autoloadBunfig: false } });
        if (!result.success) throw new AggregateError(result.logs, "Desktop fixture compilation failed");
      }
      const command = compiled ? [binary, "--desktop"] : [process.execPath, "--no-env-file", fixture];
      const nativeCommand = process.platform === "win32" ? [join(windowsSystem, "WindowsPowerShell", "v1.0", "powershell.exe"),
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        resolve(import.meta.dir, "../../scripts/windows-native-pipe-host.ps1")] : command;
      child = Bun.spawn(nativeCommand, { cwd: process.platform === "win32" ? windowsSystem : directory,
        env: { ...process.env, PATH: "", LUMIVERSE_DESKTOP_CHANNEL_TOKEN: token, LUMIVERSE_NATIVE_SMOKE_COMMAND: JSON.stringify(command) },
        stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      timer = setTimeout(kill, 15_000);
      const stderr = new Response(child.stderr).text();
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const frame = async () => {
        while (!buffer.includes("\n")) {
          const {value, done} = await reader.read();
          if (done) throw new Error(`Desktop channel exited before replying: ${await stderr}`);
          buffer += decoder.decode(value, {stream:true});
        }
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        expect(line.startsWith("\x1e")).toBe(true);
        const result = JSON.parse(line.slice(1));
        expect(result.token).toBe(token);
        return result;
      };
      expect((await frame()).type).toBe("status");
      expect((await frame()).type).toBe("setup");
      // Neither command may wait for the parent to close stdin. Split a UTF-8
      // code point across writes too, as native pipe reads can split anywhere.
      const request = new TextEncoder().encode(JSON.stringify({id:"defaults 🌌",type:"defaults"}) + "\n");
      const split = request.indexOf(0xf0) + 2;
      child.stdin.write(request.slice(0, split)); await child.stdin.flush();
      await Bun.sleep(30);
      child.stdin.write(request.slice(split)); await child.stdin.flush();
      expect(await frame()).toEqual({token,type:"response",id:"defaults 🌌",success:true,data:defaults});
      child.stdin.write(JSON.stringify({id:"status",type:"status"}) + "\r\n"); await child.stdin.flush();
      expect(await frame()).toMatchObject({type:"response",id:"status",success:true,data:{setupState:"setup"}});
      expect(child.exitCode).toBeNull();
      child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(await stderr).toBe("");
    } finally {
      clearTimeout(timer);
      kill();
      if (child) await child.exited;
      rmSync(directory, {recursive:true,force:true});
    }
  }, 40_000);
}
