import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Execute the actual helper with process operations replaced by in-process
// doubles: these tests never install anything or launch Desktop.
const source = readFileSync(new URL("../desktop/src-tauri/src/runner.rs", import.meta.url), "utf8");
const helpers = [...source.matchAll(/const WINDOWS_DESKTOP_UPDATE_HELPER: &str = r#"([\s\S]*?)"#;/g)];
if (helpers.length !== 1) throw new Error("Expected exactly one Windows desktop update helper");
const helper = helpers[0][1];
const anchor = "$ErrorActionPreference = 'Stop'";
if (helper.split(anchor).length !== 2) throw new Error("Expected exactly one helper initialization anchor");
const windowsTest = process.platform === "win32" ? test : test.skip;

for (const installerExitCode of [0, 1]) {
  for (const [resumeServer, reopenFrontend] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    windowsTest(`update helper exit=${installerExitCode} restores server=${resumeServer}, browser=${reopenFrontend}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "lumiverse-update-test-"));
      try {
        const scriptPath = join(dir, "helper.ps1");
        const installerPath = join(dir, "installer.exe");
        const fallbackPath = join(dir, "desktop.exe");
        const launchPath = join(dir, "launch.txt");
        const readyPath = join(dir, "ready");
        writeFileSync(installerPath, "fixture");
        writeFileSync(fallbackPath, "fixture");
        const doubles = `
function Get-Process { param($Id, $ErrorAction) return $null }
function Get-ChildItem { param($LiteralPath, $Filter, [switch]$File, [switch]$Recurse, $ErrorAction) return $null }
function Start-Process {
  param($FilePath, $ArgumentList, [switch]$PassThru, [switch]$Wait, $WindowStyle)
  if ($FilePath -eq $InstallerPath) {
    if ($ArgumentList -ne '/S' -or -not $Wait) { throw 'Expected silent, awaited install' }
    return [pscustomobject]@{ ExitCode = ${installerExitCode} }
  }
  if ($FilePath -ne $FallbackExecutable) { throw 'Unexpected relaunch executable' }
  if ($WindowStyle -ne 'Hidden') { throw 'Expected hidden relaunch' }
  Set-Content -LiteralPath $env:LUMIVERSE_TEST_LAUNCH -Value ($ArgumentList -join ' ') -Encoding ASCII
}
`;
        writeFileSync(scriptPath, helper.replace(anchor, () => doubles + "\n" + anchor));
        const result = spawnSync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
          "-ParentPid", "2147483647", "-InstallerPath", installerPath,
          "-FallbackExecutable", fallbackPath, "-LogPath", join(dir, "update.log"),
          "-ReadyPath", readyPath, "-ResumeServer", String(resumeServer),
          "-ReopenFrontend", String(reopenFrontend),
        ], { encoding: "utf8", timeout: 15_000, windowsHide: true, env: { ...process.env, LUMIVERSE_TEST_LAUNCH: launchPath } });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(installerExitCode);
        const expected = ["--resume-after-update"];
        if (resumeServer) expected.push("--resume-server");
        if (reopenFrontend) expected.push("--reopen-frontend");
        expect(readFileSync(launchPath, "utf8").trim()).toBe(expected.join(" "));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }
}
