import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  appImageBundleDirectory,
  requestedAppImage,
  tauriBuildEnvironment,
  tauriBuildLogLine,
  forwardTauriBuildStderr,
} from "./tauri-finalized";

describe("finalized Tauri build routing", () => {
  test("enables Tauri's supported AppImage media bundler", async () => {
    const config = await Bun.file(join(
      import.meta.dir,
      "..",
      "desktop",
      "src-tauri",
      "tauri.conf.json",
    )).json();
    expect(config.bundle.linux.appimage.bundleMediaFramework).toBe(true);
  });

  test("finalizes default and explicit AppImage builds", () => {
    expect(requestedAppImage(["build"])).toBe(true);
    expect(requestedAppImage(["build", "--bundles", "appimage,deb"])).toBe(true);
    expect(requestedAppImage(["build", "--bundles=all"])).toBe(true);
  });

  test("leaves builds without an AppImage alone", () => {
    expect(requestedAppImage(["build", "--no-bundle"])).toBe(false);
    expect(requestedAppImage(["build", "--no-bundle", "--bundles=appimage"])).toBe(false);
    expect(requestedAppImage(["build", "--bundles", "deb,rpm"])).toBe(false);
    expect(requestedAppImage(["build", "--bundles=dmg"])).toBe(false);
  });

  test("prepares standalone AppImage bundling and skips compile-only builds", () => {
    const env = { KEEP: "yes" };
    expect(tauriBuildEnvironment(["build", "--no-bundle"], "linux", env)).toBe(env);
    expect(tauriBuildEnvironment(["bundle", "--bundles=appimage"], "linux", env, () => undefined))
      .toMatchObject({ KEEP: "yes", APPIMAGE_EXTRACT_AND_RUN: "1", NO_STRIP: "1" });
    expect(tauriBuildEnvironment(["bundle", "--bundles=deb"], "linux", env)).toBe(env);
    expect(appImageBundleDirectory(["bundle", "--target=aarch64-unknown-linux-gnu"]))
      .toEndWith(join("target", "aarch64-unknown-linux-gnu", "release", "bundle", "appimage"));
  });

  test("routes target-specific bundles to Tauri's target directory", () => {
    expect(appImageBundleDirectory(["build", "--target", "aarch64-unknown-linux-gnu"]))
      .toEndWith(join("desktop", "src-tauri", "target", "aarch64-unknown-linux-gnu", "release", "bundle", "appimage"));
    expect(appImageBundleDirectory(["build", "--target=x86_64-unknown-linux-gnu"]))
      .toEndWith(join("desktop", "src-tauri", "target", "x86_64-unknown-linux-gnu", "release", "bundle", "appimage"));
  });

  test("uses FUSE-free, RELR-compatible linuxdeploy settings for Linux AppImages", () => {
    expect(tauriBuildEnvironment(["build"], "linux", { KEEP: "yes" }, () => undefined)).toEqual({
      KEEP: "yes",
      APPIMAGE_EXTRACT_AND_RUN: "1",
      NO_STRIP: "1",
      PATCHELF: join(import.meta.dir, "appimage-patchelf.sh"),
      LUMIVERSE_REAL_PATCHELF: Bun.which("patchelf") || "patchelf",
    });
  });

  test("passes distro-specific GStreamer locations to the AppImage plugin", () => {
    const directories = {
      pluginsdir: "/usr/lib64/gstreamer-1.0",
      pluginscannerdir: "/usr/libexec/gstreamer-1.0",
    } as const;
    expect(tauriBuildEnvironment(
      ["build", "--bundles", "appimage"],
      "linux",
      { KEEP: "yes" },
      (variable) => directories[variable],
    )).toEqual({
      KEEP: "yes",
      APPIMAGE_EXTRACT_AND_RUN: "1",
      NO_STRIP: "1",
      PATCHELF: join(import.meta.dir, "appimage-patchelf.sh"),
      LUMIVERSE_REAL_PATCHELF: Bun.which("patchelf") || "patchelf",
      GSTREAMER_PLUGINS_DIR: directories.pluginsdir,
      GSTREAMER_HELPERS_DIR: directories.pluginscannerdir,
    });
  });

  test("preserves explicit GStreamer build-host overrides", () => {
    expect(tauriBuildEnvironment(
      ["build"],
      "linux",
      {
        GSTREAMER_PLUGINS_DIR: "/custom/plugins",
        GSTREAMER_HELPERS_DIR: "/custom/helpers",
      },
      () => {
        throw new Error("pkg-config resolver should not run for explicit paths");
      },
    )).toMatchObject({
      GSTREAMER_PLUGINS_DIR: "/custom/plugins",
      GSTREAMER_HELPERS_DIR: "/custom/helpers",
    });
  });

  test("does not alter other platforms or non-AppImage builds", () => {
    const env = { KEEP: "yes" };
    expect(tauriBuildEnvironment(["build"], "darwin", env)).toBe(env);
    expect(tauriBuildEnvironment(["build", "--bundles", "deb,rpm"], "linux", env)).toBe(env);
  });
});

describe("macOS ad hoc build diagnostics", () => {
  const warning = "        Warn skipping app notarization, no APPLE_ID & APPLE_PASSWORD & APPLE_TEAM_ID or APPLE_API_KEY & APPLE_API_ISSUER & APPLE_API_KEY_PATH environment variables found";
  const notice = "        Info macOS installer uses ad hoc signing without notarization.";
  const env = { APPLE_SIGNING_IDENTITY: "-" };

  test("reports the expected missing-credentials message as an informational notice", () => {
    expect(tauriBuildLogLine(warning, "darwin", env)).toBe(notice);
    expect(tauriBuildLogLine(warning.replace("Warn", "\u001b[33mWarn\u001b[0m"), "darwin", env)).toBe(notice);
  });

  test("preserves other warnings, errors and notarization failures", () => {
    for (const line of [
      "warning: associated function `new` is never used",
      "error: could not compile lumiverse-tray",
      "        Warn skipping app notarization, Apple credentials were rejected",
      "        Warn Failed to get icon name from Assets.car file",
    ]) expect(tauriBuildLogLine(line, "darwin", env)).toBe(line);
  });

  test("preserves the warning outside explicit ad hoc macOS builds", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(tauriBuildLogLine(warning, platform, env)).toBe(warning);
    }
    expect(tauriBuildLogLine(warning, "darwin", {})).toBe(warning);
    expect(tauriBuildLogLine(warning, "darwin", { APPLE_SIGNING_IDENTITY: "Developer ID Application" })).toBe(warning);
    for (const key of ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"]) {
      expect(tauriBuildLogLine(warning, "darwin", { ...env, [key]: "configured" })).toBe(warning);
    }
  });

  test("forwards fragmented UTF-8 and CRLF logs, including the final error without a newline", async () => {
    const input = `${warning}\r\nwarning: preserve résumé diagnostic\r\nerror: build failed`;
    const bytes = new TextEncoder().encode(input);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // One byte per chunk splits both lines and multibyte characters.
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    let output = "";
    await forwardTauriBuildStderr(stream, (line) => { output += line; }, "darwin", env);
    expect(output).toBe(`${notice}\nwarning: preserve résumé diagnostic\nerror: build failed\n`);
  });
});
