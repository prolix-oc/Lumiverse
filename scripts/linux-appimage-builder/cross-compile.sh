#!/usr/bin/env bash
# Run only with native x64 Rust tools. ARM64 tests execute in a later container.
set -euo pipefail
rustc -vV | grep -Fx 'host: x86_64-unknown-linux-gnu'
test "$(bun -p 'process.arch')" = x64
target=aarch64-unknown-linux-gnu
case "${1:?usage: cross-compile.sh prepare|tests|app}" in
  prepare)
    bun install --frozen-lockfile
    bun install --cwd frontend --frozen-lockfile
    bun install --cwd desktop --frozen-lockfile
    bun x tsc --noEmit
    bun x tsc --project scripts/tsconfig.server-bundle.json --noEmit
    bun run --cwd frontend build
    bun run --cwd desktop build
    ;;
  tests)
    cargo test --locked --manifest-path desktop/tools/verify-updater/Cargo.toml
    cargo test --release --locked --lib --no-run --target "$target" --timings \
      --manifest-path desktop/src-tauri/Cargo.toml --message-format=json-render-diagnostics \
      > desktop/src-tauri/target/arm64-tests.jsonl
    bun scripts/linux-arm64-cross.ts record-tests
    ;;
  app)
    bun run --cwd desktop tauri:finalized build --verbose --target "$target" --no-bundle \
      --config src-tauri/tauri.server-bundle.conf.json --config src-tauri/tauri.release-updater.conf.json \
      --ci -- --locked --timings
    bun scripts/linux-arm64-cross.ts verify-app
    ;;
  *) echo 'Expected prepare, tests or app.' >&2; exit 1 ;;
esac
