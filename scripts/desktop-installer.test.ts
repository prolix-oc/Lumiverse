import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  desktopStopCommand,
  installDesktopBundle,
  linuxDesktopEntry,
  resolveLinuxDesktopDir,
  selectDesktopInstallArtifact,
} from "./desktop-installer";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-desktop-install-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("selectDesktopInstallArtifact", () => {
  test("selects the newest platform-native artifact", () => {
    const root = tempRoot();
    const nsis = join(root, "nsis");
    mkdirSync(nsis, { recursive: true });
    const old = join(nsis, "Lumiverse Desktop_0.1.0_x64-setup.exe");
    const fresh = join(nsis, "Lumiverse Desktop_0.2.1_x64-setup.exe");
    writeFileSync(old, "old");
    writeFileSync(fresh, "fresh");
    const then = new Date(Date.now() - 60_000);
    utimesSync(old, then, then);

    expect(selectDesktopInstallArtifact(root, "win32")).toBe(fresh);
  });

  test("prefers NSIS over MSI for a user-local Windows install", () => {
    const root = tempRoot();
    mkdirSync(join(root, "nsis"), { recursive: true });
    mkdirSync(join(root, "msi"), { recursive: true });
    writeFileSync(join(root, "nsis", "setup.exe"), "nsis");
    writeFileSync(join(root, "msi", "setup.msi"), "msi");
    expect(selectDesktopInstallArtifact(root, "win32")).toEndWith("setup.exe");
  });
});

describe("desktopStopCommand", () => {
  test("uses an exact executable name and process-tree cleanup on Unix", () => {
    for (const target of ["darwin", "linux"] as const) {
      const command = desktopStopCommand(target);
      expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
      expect(command[2]).toContain('pgrep -x "$app_name"');
      expect(command[2]).toContain("kill -TERM $tree");
      expect(command.at(-1)).toBe("lumiverse-tray");
    }
  });

  test("uses taskkill tree termination for the Windows executable", () => {
    const command = desktopStopCommand("win32");
    expect(command[0]).toBe("powershell.exe");
    expect(command.at(-1)).toContain("taskkill.exe /PID $process.Id /T /F");
    expect(command.at(-1)).toContain("lumiverse-tray");
  });
});

test("macOS install copies the app and refreshes its desktop symlink", async () => {
  const root = tempRoot();
  const home = join(root, "home");
  const applications = join(root, "Applications");
  const artifact = join(root, "bundle", "Lumiverse Desktop.app");
  mkdirSync(join(artifact, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(home, "Desktop"), { recursive: true });
  const legacyApp = join(home, "Applications", "Lumiverse Desktop.app");
  mkdirSync(join(legacyApp, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(legacyApp, "Contents", "MacOS", "lumiverse-tray"), "stale-binary");
  writeFileSync(join(artifact, "Contents", "MacOS", "lumiverse-tray"), "binary");
  const staleTarget = join(home, "old.app");
  symlinkSync(staleTarget, join(home, "Desktop", "Lumiverse Desktop.app"));
  const commands: string[][] = [];

  const result = await installDesktopBundle(artifact, "darwin", {
    homeDir: home,
    macApplicationsDir: applications,
    runCommand: async (command) => {
      commands.push(command);
      return 0;
    },
  });

  expect(result.installedPath).toBe(join(applications, "Lumiverse Desktop.app"));
  expect(readFileSync(join(result.installedPath, "Contents", "MacOS", "lumiverse-tray"), "utf8")).toBe("binary");
  expect(existsSync(artifact)).toBe(false);
  expect(existsSync(legacyApp)).toBe(false);
  expect(result.shortcuts).toHaveLength(2);
  expect(commands.some((command) => command.includes("-f") && command.includes(result.installedPath))).toBe(true);
  expect(commands).toContainEqual(["/usr/bin/mdimport", result.installedPath]);
});

test("Linux install writes executable AppImage and application/desktop launchers", async () => {
  const root = tempRoot();
  const home = join(root, "home");
  const artifact = join(root, "Lumiverse.AppImage");
  mkdirSync(join(home, "Desktop"), { recursive: true });
  writeFileSync(artifact, "appimage");

  const result = await installDesktopBundle(artifact, "linux", {
    homeDir: home,
    env: {},
    runCommand: async () => 0,
  });
  const launcher = join(home, ".local", "share", "applications", "chat.lumiverse.tray.desktop");

  expect(readFileSync(result.installedPath, "utf8")).toBe("appimage");
  expect(statSync(result.installedPath).mode & 0o111).not.toBe(0);
  expect(readFileSync(launcher, "utf8")).toContain(`Exec="${result.installedPath}"`);
  expect(readFileSync(join(home, "Desktop", "Lumiverse Desktop.desktop"), "utf8")).toBe(readFileSync(launcher, "utf8"));
});

test("Linux desktop directory follows user-dirs.dirs", () => {
  const root = tempRoot();
  const home = join(root, "home");
  const config = join(root, "config");
  const desktop = join(home, "Workspace");
  mkdirSync(config, { recursive: true });
  mkdirSync(desktop, { recursive: true });
  writeFileSync(join(config, "user-dirs.dirs"), 'XDG_DESKTOP_DIR="$HOME/Workspace"\n');
  expect(resolveLinuxDesktopDir(home, { XDG_CONFIG_HOME: config })).toBe(desktop);
});

test("desktop entry quotes shell-significant path characters", () => {
  expect(linuxDesktopEntry('/home/test/My $App`/Lumiverse.AppImage')).toContain(
    'Exec="/home/test/My \\$App\\`/Lumiverse.AppImage"',
  );
});

test("Windows runs the current-user installer and creates a desktop shortcut", async () => {
  const commands: string[][] = [];
  const result = await installDesktopBundle("C:\\build\\Lumiverse Desktop-setup.exe", "win32", {
    runCommand: async (command) => {
      commands.push(command);
      return 0;
    },
  });

  expect(commands[0]?.[0]).toBe("powershell.exe");
  expect(commands[0]?.at(-1)).toContain("taskkill.exe");
  expect(commands[1]).toEqual(["C:\\build\\Lumiverse Desktop-setup.exe", "/S"]);
  expect(commands[2]?.[0]).toBe("powershell.exe");
  expect(commands[2]?.at(-1)).toContain("Lumiverse Desktop.lnk");
  expect(result.shortcuts).toHaveLength(2);
});

test("installation stops before replacing files when the running app cannot be killed", async () => {
  const root = tempRoot();
  const home = join(root, "home");
  const artifact = join(root, "Lumiverse.AppImage");
  writeFileSync(artifact, "appimage");

  await expect(installDesktopBundle(artifact, "linux", {
    homeDir: home,
    env: {},
    runCommand: async () => 9,
  })).rejects.toThrow("Could not stop the running Lumiverse Desktop app");

  expect(existsSync(artifact)).toBe(true);
  expect(existsSync(join(home, ".local", "opt", "lumiverse-desktop"))).toBe(false);
});
