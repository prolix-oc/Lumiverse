#!/usr/bin/env bash
set -euo pipefail
test "$(bun --version)" = 1.4.4
test "$(bun -p 'process.arch')" = "${LUMIVERSE_BUILD_ARCH:?expected build architecture}"
case "$LUMIVERSE_BUILD_ARCH" in
  x64) expected_target=x86_64-unknown-linux-gnu; test_timeout=5000 ;;
  # Packaging fixtures launch many processes, which are slower under QEMU.
  arm64) expected_target=aarch64-unknown-linux-gnu; test_timeout=60000 ;;
  *) exit 1 ;;
esac
rustc -vV | grep -Fx "host: $expected_target"
bun install --frozen-lockfile
bun install --cwd frontend --frozen-lockfile
bun install --cwd desktop --frozen-lockfile

version="$(bun -e 'import { diagnosticVersion } from "./scripts/build-linux-appimage-remote"; console.log(diagnosticVersion((await Bun.file("desktop/package.json").json()).version, process.env.DIAGNOSTIC_BUILD_ID))')"
bun run desktop:version "$version"
git init -q --initial-branch=diagnostic
git add -A
git -c user.name='Lumiverse diagnostic build' -c user.email='diagnostic@localhost' \
  -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm "Diagnostic source snapshot $DIAGNOSTIC_BUILD_ID"

bun run --cwd desktop build
bun --no-env-file test --timeout "$test_timeout" desktop/tests/frontend-startup-shell.test.ts desktop/tests/linux-desktop.test.ts \
  frontend/src/theme/linuxUiScale.test.ts scripts/tauri-finalized.test.ts scripts/appimage-packaging.test.ts scripts/appimage-runtime-manifest.test.ts
cargo test --release --locked --lib --manifest-path desktop/src-tauri/Cargo.toml
bun run build:server
bun run test:server-bundle
bun run build:desktop-server --reuse-server --stage-only
rm -rf desktop/src-tauri/target/release/bundle/appimage
bun run --cwd desktop tauri:finalized build --verbose --config src-tauri/tauri.server-bundle.conf.json --bundles appimage --ci -- --locked
