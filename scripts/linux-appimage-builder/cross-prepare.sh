#!/usr/bin/env bash
# Run in the ARM64 runtime container. Keep native server dependencies and all
# architecture-sensitive checks on ARM64; Rust compilation happens separately.
set -euo pipefail
test "$(bun --version)" = 1.4.4
test "$(bun -p 'process.arch')" = arm64
checks() {
  bun install --frozen-lockfile
  bun install --cwd frontend --frozen-lockfile
  bun install --cwd desktop --frozen-lockfile
  bun --no-env-file test --timeout 60000 tests/server-bundle.test.ts tests/lancedb-macos-native.test.ts \
    tests/bun-runtime-version-policy.test.ts scripts/desktop-release.test.ts desktop/src-tauri/permissions.test.ts \
    desktop/tests/desktop-updates.test.ts desktop/tests/instance-connection.test.ts desktop/tests/custom-url-ui.test.ts \
    desktop/tests/local-server.test.ts desktop/tests/runner-client.test.ts scripts/desktop-session-restoration.test.ts \
    scripts/tauri-finalized.test.ts scripts/appimage-packaging.test.ts scripts/appimage-runtime-manifest.test.ts \
    desktop/tests/linux-desktop.test.ts desktop/tests/frontend-startup-shell.test.ts frontend/src/theme/linuxUiScale.test.ts \
    scripts/private-linux-release.test.ts src/spindle/runtime-transport.test.ts src/db/execution-transport.test.ts
  NODE_ENV=production bun --no-env-file test --timeout 60000 src/auth/request-cookies.integration.test.ts
  if [[ -f /release-request.json ]]; then
    version="$(bun -p '(await Bun.file("/release-request.json").json()).version')"
    bun run desktop:version "$version"
  elif [[ -n "${DIAGNOSTIC_BUILD_ID:-}" ]]; then
    version="$(bun -e 'import { diagnosticVersion } from "./scripts/build-linux-appimage-remote"; console.log(diagnosticVersion((await Bun.file("desktop/package.json").json()).version, process.env.DIAGNOSTIC_BUILD_ID))')"
    bun run desktop:version "$version"
    git init -q --initial-branch=diagnostic
    git add -A
    git -c user.name='Lumiverse diagnostic build' -c user.email='diagnostic@localhost' \
      -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm "Diagnostic source snapshot $DIAGNOSTIC_BUILD_ID"
  else
    echo 'A release request or diagnostic build ID is required.' >&2
    exit 1
  fi
}

server() {
  bun run build:server --skip-frontend-build
  bun run test:server-bundle
  bun run build:desktop-server --reuse-server --stage-only
  # Signing keys are deliberately absent. The public completion workflow signs
  # only the final image after the private build and smoke tests succeed.
  bun -e 'const request = await Bun.file("/release-request.json").exists() ? await Bun.file("/release-request.json").json() : {}; await Bun.write("desktop/src-tauri/tauri.release-updater.conf.json", JSON.stringify({bundle:{createUpdaterArtifacts:false},plugins:{updater:{pubkey:request.publicKey || ""}}}));'
}

case "${1:?usage: cross-prepare.sh checks|server}" in
  checks) checks ;;
  server) server ;;
  *) echo 'Expected checks or server.' >&2; exit 1 ;;
esac
