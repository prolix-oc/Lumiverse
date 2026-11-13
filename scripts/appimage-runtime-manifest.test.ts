import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeManifest } from "./appimage-runtime-manifest";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-runtime-")); roots.push(root);
  mkdirSync(join(root, "usr/lib"), { recursive: true });
  writeFileSync(join(root, "usr/lib/libwebkit2gtk-4.1.so.0"), "webkit fixture");
  writeFileSync(join(root, "usr/lib/WebKitWebProcess"), "WebKit web helper");
  writeFileSync(join(root, "usr/lib/WebKitNetworkProcess"), "WebKit network helper");
  return root;
}
test("runtime manifest verifies the exact packaged libraries and rejects mutation", () => {
  const root = fixture();
  let probes = 0;
  const metadata = () => {
    probes++;
    return {
      revision: "fixture-revision", architecture: "arm64" as const, buildOS: "fixture-linux",
      glibc: "glibc 2.35", nativeVersions: { "glib-2.0": "fixture-glib" },
      debianPackages: "fixture-packages", crates: {}, tauriCli: "fixture-cli", packagingToolSha256: {},
    };
  };
  // Integrity checks must not spawn host tools (getconf, pkg-config, Git),
  // especially on Windows ARM64 where the unit-test deadline is only 5 s.
  runtimeManifest(root, false, metadata);
  const verified = runtimeManifest(root, true, metadata);
  expect(verified.nativeVersions["glib-2.0"]).toBe("fixture-glib");
  expect(verified.revision).toBe("fixture-revision");
  expect(readFileSync(join(root, "usr/share/lumiverse/runtime-manifest.json"), "utf8")).toContain("2.35");
  writeFileSync(join(root, "usr/lib/libwebkit2gtk-4.1.so.0"), "changed");
  expect(() => runtimeManifest(root, true, metadata)).toThrow("differs from its manifest");
  expect(probes).toBe(1);
});
test.each(["libEGL.so.1", "libGLX.so.0", "libwayland-client.so.0", "libnvidia-eglcore.so.615"])("rejects host graphics library %s", name => {
  const root = fixture(); writeFileSync(join(root, "usr/lib", name), "host");
  expect(() => runtimeManifest(root)).toThrow("host graphics libraries");
});
test.skipIf(process.platform === "win32")("does not silently hash a host WebKit library through a bundle symlink", () => {
  const root = fixture(); const host = join(root, "../", `${root.split(/[\\/]/).at(-1)}-host`);
  roots.push(host); mkdirSync(host); writeFileSync(join(host, "libgio.so.0"), "host");
  symlinkSync(join(host, "libgio.so.0"), join(root, "usr/lib/libgio.so.0"));
  expect(() => runtimeManifest(root)).toThrow("symlink escapes");
});
