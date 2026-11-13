#!/usr/bin/env bash
set -euo pipefail
test "$(bun --version)" = 1.4.4
test "$(bun -p 'process.arch')" = "${LUMIVERSE_BUILD_ARCH:?}"
case "$LUMIVERSE_BUILD_ARCH" in
  x64) expected_target=x86_64-unknown-linux-gnu; test_timeout=5000 ;;
  arm64) expected_target=aarch64-unknown-linux-gnu; test_timeout=60000 ;;
  *) exit 1 ;;
esac
rustc -vV | grep -Fx "host: $expected_target"
bun install --frozen-lockfile
bun install --cwd frontend --frozen-lockfile
bun install --cwd desktop --frozen-lockfile
bun --no-env-file test --timeout "$test_timeout" tests/server-bundle.test.ts tests/lancedb-macos-native.test.ts \
  tests/bun-runtime-version-policy.test.ts scripts/desktop-release.test.ts desktop/src-tauri/permissions.test.ts \
  desktop/tests/desktop-updates.test.ts desktop/tests/instance-connection.test.ts desktop/tests/custom-url-ui.test.ts \
  desktop/tests/local-server.test.ts desktop/tests/runner-client.test.ts scripts/desktop-session-restoration.test.ts \
  scripts/tauri-finalized.test.ts scripts/appimage-packaging.test.ts scripts/appimage-runtime-manifest.test.ts \
  desktop/tests/linux-desktop.test.ts desktop/tests/frontend-startup-shell.test.ts frontend/src/theme/linuxUiScale.test.ts \
  scripts/private-linux-release.test.ts src/spindle/runtime-transport.test.ts src/db/execution-transport.test.ts
NODE_ENV=production bun --no-env-file test --timeout "$test_timeout" src/auth/request-cookies.integration.test.ts
bun x tsc --noEmit
bun x tsc --project scripts/tsconfig.server-bundle.json --noEmit
cargo test --locked --manifest-path desktop/tools/verify-updater/Cargo.toml
bun run --cwd desktop build
cargo test --release --locked --lib --manifest-path desktop/src-tauri/Cargo.toml
bun run build:server
bun run test:server-bundle
version="$(bun -p '(await Bun.file("/release-request.json").json()).version')"
bun run desktop:version "$version"
bun run build:desktop-server --reuse-server --stage-only
# The updater key is public metadata. Private signing keys stay on the hosted
# completion job; build the final image with its real version and public key.
bun -e 'const request = await Bun.file("/release-request.json").json(); await Bun.write("desktop/src-tauri/tauri.release-updater.conf.json", JSON.stringify({bundle:{createUpdaterArtifacts:false},plugins:{updater:{pubkey:request.publicKey}}}));'
rm -rf desktop/src-tauri/target/release/bundle/appimage
bun run --cwd desktop tauri:finalized build --verbose --config src-tauri/tauri.server-bundle.conf.json \
  --config src-tauri/tauri.release-updater.conf.json --bundles appimage --ci -- --locked
