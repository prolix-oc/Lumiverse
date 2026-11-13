import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scriptDir = import.meta.dir;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Portable checks use a tar-backed runtime/output fixture. An integration test
// also exercises the real SquashFS tools when they are installed (as in CI).
const runtimeSize = 4096;
function runtimeSource(nativeSquashfs: boolean): string {
  const extraction = nativeSquashfs
    ? `unsquashfs -no-progress -offset ${runtimeSize} -dest squashfs-root "$0"`
    : `mkdir squashfs-root\n    tail -c +${runtimeSize + 1} "$0" | tar -xpf - -C squashfs-root`;
  return `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --appimage-offset) echo ${runtimeSize} ;;
  --appimage-extract)
    ${extraction}
    find squashfs-root -type d -exec chmod 700 {} +
    ;;
  *) exit 1 ;;
esac
exit 0
`;
}

function write(path: string, contents: string | Buffer, mode = 0o644): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, mode);
}

function fixture(nativeSquashfs = false) {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-packaging-test-"));
  roots.push(root);
  const bundle = join(root, "bundle with spaces");
  const appdir = join(bundle, "Lumiverse Desktop.AppDir");
  const appimage = join(bundle, "Lumiverse Desktop_0.3.1_amd64.AppImage");
  const toolDir = join(root, "tools");
  const outputPlugin = join(toolDir, "output-plugin");
  for (const entry of ["AppRun", "AppRun.wrapped", "usr/bin/lumiverse-tray",
    "usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner", "usr/lib/WebKitWebProcess", "usr/lib/WebKitNetworkProcess"]) {
    write(join(appdir, entry), "#!/bin/sh\nexit 0\n", 0o755);
  }
  for (const name of ["app", "audioconvert", "audioparsers", "audioresample", "autodetect",
    "pulseaudio", "coreelements", "mpg123", "playback", "typefindfunctions", "volume"]) {
    write(join(appdir, "usr/lib/gstreamer-1.0", `libgst${name}.so`), "plugin fixture\n");
  }
  write(join(appdir, "apprun-hooks/linuxdeploy-plugin-gstreamer.sh"), [
    'GST_PLUGIN_SYSTEM_PATH_1_0="${APPDIR}/usr/lib/gstreamer-1.0"',
    'GST_PLUGIN_PATH_1_0="${APPDIR}/usr/lib/gstreamer-1.0"',
    'GST_PLUGIN_SCANNER_1_0="${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"',
  ].join("\n"));
  write(join(toolDir, "gst-inspect-1.0"), "#!/bin/sh\nexit 0\n", 0o755);
  if (!nativeSquashfs) {
    write(join(toolDir, "unsquashfs"), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == -no-progress && "$2" == -offset && "$4" == -dest ]]
offset="$3"
destination="$5"
mkdir "$destination"
tail -c +"$((offset + 1))" "$6" | tar -xpf - -C "$destination"
`, 0o755);
  }
  write(outputPlugin, `#!/usr/bin/env bash
set -euo pipefail
appdir="\${2#--appdir=}"
if [[ "\${BREAK_PACKAGED_PERMISSIONS:-}" == 1 ]]; then
  chmod 770 "$appdir/AppRun.wrapped"
fi
if [[ "\${BREAK_PACKAGED_DIRECTORY:-}" == 1 ]]; then
  chmod 700 "$appdir/usr"
fi
cat "$LDAI_RUNTIME_FILE" > "$LDAI_OUTPUT"
${nativeSquashfs
  ? 'mksquashfs "$appdir" "$LDAI_OUTPUT.squashfs" -noappend -no-progress -processors 1 -all-root >/dev/null\ncat "$LDAI_OUTPUT.squashfs" >> "$LDAI_OUTPUT"'
  : 'tar -cpf - -C "$appdir" . >> "$LDAI_OUTPUT"'}
`, 0o755);
  const runtime = Buffer.alloc(runtimeSize, " ");
  runtime.write(runtimeSource(nativeSquashfs));
  write(appimage, runtime, 0o755);
  return { root, bundle, appdir, appimage, env: {
    ...process.env,
    PATH: `${toolDir}:${process.env.PATH}`,
    LUMIVERSE_APPIMAGE_PLUGIN: outputPlugin,
  } };
}

function run(script: string, argument: string, env = process.env) {
  const result = Bun.spawnSync(["bash", join(scriptDir, script), argument], {
    env, stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

function extract(appimage: string, root: string, env: NodeJS.ProcessEnv) {
  const directory = join(root, "inspection");
  mkdirSync(directory);
  const result = Bun.spawnSync(["unsquashfs", "-no-progress", "-offset", String(runtimeSize),
    "-dest", join(directory, "squashfs-root"), appimage], { env, stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return join(directory, "squashfs-root");
}

describe.skipIf(process.platform === "win32")("AppImage packaging permissions", () => {
  test("preserves Bun ELF bytes while forwarding other patchelf operations and errors", () => {
    const f = fixture();
    const server = join(f.appdir, "usr/bin/lumiverse-server");
    const tray = join(f.appdir, "usr/bin/lumiverse-tray");
    const patchelf = join(f.root, "fake-patchelf");
    const log = join(f.root, "patchelf.log");
    const original = Buffer.from("compiled Bun with embedded application\n");
    write(server, original, 0o755);
    write(patchelf, '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$@" > "$LUMIVERSE_PATCHELF_TEST_LOG"\nif [[ "$1" == --set-rpath ]]; then printf rewritten > "$3"; fi\nexit "${LUMIVERSE_PATCHELF_TEST_EXIT:-0}"\n', 0o755);
    const patch = (args: string[], exit = "0") => Bun.spawnSync(["bash", join(scriptDir, "appimage-patchelf.sh"), ...args], {
      env: { ...f.env, LUMIVERSE_REAL_PATCHELF: patchelf, LUMIVERSE_PATCHELF_TEST_LOG: log, LUMIVERSE_PATCHELF_TEST_EXIT: exit },
      stdout: "pipe", stderr: "pipe",
    });
    expect(patch(["--set-rpath", "$ORIGIN/../lib", server]).exitCode).toBe(0);
    expect(readFileSync(server)).toEqual(original);
    expect(() => statSync(log)).toThrow();
    expect(patch(["--set-rpath", "$ORIGIN/../lib", tray]).exitCode).toBe(0);
    expect(readFileSync(tray, "utf8")).toBe("rewritten");
    expect(patch(["--print-rpath", server], "9").exitCode).toBe(9);
    expect(readFileSync(log, "utf8")).toBe(`--print-rpath\n${server}\n`);
  });

  test("rejects a launcher that is executable only for its owner and group", () => {
    const f = fixture();
    chmodSync(join(f.appdir, "AppRun.wrapped"), 0o770);
    const result = run("verify-appimage-permissions.sh", f.appdir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("AppRun.wrapped");
  });

  test("rejects a required launcher that has no execute bits", () => {
    const f = fixture();
    chmodSync(join(f.appdir, "AppRun.wrapped"), 0o644);
    const result = run("verify-appimage-permissions.sh", f.appdir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("AppRun.wrapped");
  });

  test.each(["resource", "directory", "helper"])("rejects inaccessible %s outside the main launchers", (kind) => {
    const f = fixture();
    const entry = join(f.appdir, "usr", `private-${kind}`);
    if (kind === "directory") {
      mkdirSync(entry);
      chmodSync(entry, 0o750);
    } else {
      write(entry, "fixture", kind === "helper" ? 0o770 : 0o640);
    }
    const result = run("verify-appimage-permissions.sh", f.appdir);
    expect(result.code).toBe(1);
    expect(result.output).toContain(entry);
  });

  test.each([false, true])("repacks and repairs permissions with bundled Wayland=%s", (wayland) => {
    const f = fixture();
    chmodSync(join(f.appdir, "AppRun.wrapped"), 0o770);
    chmodSync(join(f.appdir, "usr"), 0o750);
    write(join(f.appdir, "usr/share/resource.txt"), "resource", 0o600);
    if (wayland) write(join(f.appdir, "usr/lib/libwayland-client.so.0"), "library");
    const result = run("finalize-appimage.sh", f.bundle, f.env);
    expect(result.output).toContain("Finalized Lumiverse Desktop_0.3.1_amd64.AppImage");
    expect(result.code).toBe(0);
    const packaged = extract(f.appimage, f.root, f.env);
    expect(statSync(join(packaged, "AppRun.wrapped")).mode & 0o777).toBe(0o775);
    expect(statSync(join(packaged, "usr/share/resource.txt")).mode & 0o777).toBe(0o644);
    expect(run("verify-appimage-permissions.sh", packaged).code).toBe(0);
    expect(() => statSync(join(packaged, "usr/lib/libwayland-client.so.0"))).toThrow();
  });

  test("re-finalizes safely and replaces an older inner launcher after a new linuxdeploy build", () => {
    const f = fixture();
    expect(run("finalize-appimage.sh", f.bundle, f.env).code).toBe(0);
    const original = readFileSync(join(f.appdir, "AppRun.lumiverse-inner"), "utf8");
    expect(run("finalize-appimage.sh", f.bundle, f.env).code).toBe(0);
    expect(readFileSync(join(f.appdir, "AppRun.lumiverse-inner"), "utf8")).toBe(original);
    write(join(f.appdir, "AppRun"), "#!/bin/sh\n# new upstream launcher\nexit 0\n", 0o755);
    expect(run("finalize-appimage.sh", f.bundle, f.env).code).toBe(0);
    expect(readFileSync(join(f.appdir, "AppRun.lumiverse-inner"), "utf8")).toContain("new upstream launcher");
  // Three complete shell-based repacks exceed five seconds on hosted Intel
  // macOS and under ARM64 emulation. Keep the full round-trip assertions.
  }, 60_000);

  function checkStoredPermissions(native: boolean): void {
    const f = fixture(native);
    const result = run("finalize-appimage.sh", f.bundle, f.env);
    expect(result.code).toBe(0);
    const runtimeDir = join(f.root, "runtime-extraction");
    mkdirSync(runtimeDir);
    const runtimeResult = Bun.spawnSync([f.appimage, "--appimage-extract"], {
      cwd: runtimeDir, env: f.env, stderr: "pipe",
    });
    expect(runtimeResult.exitCode).toBe(0);
    expect(statSync(join(runtimeDir, "squashfs-root/usr")).mode & 0o777).toBe(0o700);
    expect(run("verify-appimage-permissions.sh", join(runtimeDir, "squashfs-root")).code).toBe(1);
    const packaged = extract(f.appimage, f.root, f.env);
    expect(statSync(join(packaged, "usr")).mode & 0o777).toBe(0o755);
    expect(run("verify-appimage-permissions.sh", packaged).code).toBe(0);
  }

  test("checks stored permissions despite runtime extraction using private directories", () => {
    checkStoredPermissions(false);
  });

  test.skipIf(!Bun.which("mksquashfs") || !Bun.which("unsquashfs"))(
    "checks permissions stored in a real SquashFS image", () => {
      checkStoredPermissions(true);
    },
  );

  test.each(["launcher", "directory"])("rejects %s permissions reintroduced by the output tool and keeps the original image", (entry) => {
    const f = fixture();
    const original = readFileSync(f.appimage);
    const corruption = entry === "launcher"
      ? { BREAK_PACKAGED_PERMISSIONS: "1" }
      : { BREAK_PACKAGED_DIRECTORY: "1" };
    const result = run("finalize-appimage.sh", f.bundle, { ...f.env, ...corruption });
    expect(result.code).toBe(1);
    expect(result.output).toContain(entry === "launcher" ? "AppRun.wrapped" : "squashfs-root/usr");
    expect(readFileSync(f.appimage)).toEqual(original);
  });
});
