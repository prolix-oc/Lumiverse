import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  appImageBundleDirectory,
  requestedAppImage,
  tauriBuildEnvironment,
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
    expect(requestedAppImage(["build", "--bundles", "deb,rpm"])).toBe(false);
    expect(requestedAppImage(["build", "--bundles=dmg"])).toBe(false);
  });

  test("routes target-specific bundles to Tauri's target directory", () => {
    expect(appImageBundleDirectory(["build", "--target", "aarch64-unknown-linux-gnu"]))
      .toEndWith("desktop/src-tauri/target/aarch64-unknown-linux-gnu/release/bundle/appimage");
    expect(appImageBundleDirectory(["build", "--target=x86_64-unknown-linux-gnu"]))
      .toEndWith("desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage");
  });

  test("uses FUSE-free, RELR-compatible linuxdeploy settings for Linux AppImages", () => {
    expect(tauriBuildEnvironment(["build"], "linux", { KEEP: "yes" }, () => undefined)).toEqual({
      KEEP: "yes",
      APPIMAGE_EXTRACT_AND_RUN: "1",
      NO_STRIP: "1",
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
