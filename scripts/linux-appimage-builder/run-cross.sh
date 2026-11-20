#!/usr/bin/env bash
# Native compilation + ARM64 execution and packaging. Keep these volumes
# separate from both native x64 and fully emulated ARM64 release caches.
set -euo pipefail
[[ "$(uname -m)" = x86_64 ]] || { echo 'Native ARM64 cross-compilation requires an x64 Linux build host.' >&2; exit 1; }
run_dir="${1:?run directory}"
cache_dir="${2:?cache directory}"
jobs="${3:?parallel jobs}"
smoke="${4:-1}"
cargo_config="${5:-}"
prefix=lumiverse-appimage-cross-arm64
native_image=lumiverse-appimage-cross-runtime:ubuntu22.04-x64
arm_image=lumiverse-appimage-cross-runtime:ubuntu22.04-arm64
cross_image=lumiverse-appimage-cross:ubuntu22.04-arm64
source_root="$run_dir/source"
source_owner="$(stat -c '%u:%g' "$source_root")"
restore_owner=0
target_root=/workspace/desktop/src-tauri/target/aarch64-unknown-linux-gnu/release
mkdir -p "$run_dir/artifacts" "$cache_dir"
exec 9>"$cache_dir/build-cross-arm64.lock"
flock -n 9 || { echo 'Another ARM64 cross-build is using these caches.' >&2; exit 1; }
exec > >(tee "$run_dir/build.log") 2>&1

# Stable labels also let the owning workflow clean up after cancellation.
label="io.lumiverse.release-run=${GITHUB_RUN_ID:-diagnostic-$(basename "$run_dir")}"
cleanup() {
  local result=$?
  mapfile -t remaining < <(docker ps -q --filter "label=$label")
  if ((${#remaining[@]})); then docker stop --timeout 10 "${remaining[@]}" || true; fi
  if [[ "$restore_owner" = 1 && "$source_owner" != 1000:1000 ]]; then
    docker run --rm --label "$label" --platform linux/amd64 --user 0:0 --network none \
      --mount "type=bind,src=$source_root,dst=/workspace" "$cross_image" \
      chown -R "$source_owner" /workspace || result=1
  fi
  printf '%s\n' "$result" > "$run_dir/exit-status"
  exit "$result"
}
trap cleanup EXIT
# AppImage type-2 runtimes use ELF padding bytes that some binfmt rules reject.
# Check the marker as well as ordinary ELF execution before compiling anything.
if ! docker run --rm --label "$label" --platform linux/arm64 ubuntu:22.04 bash -ec '
  cp /bin/true /tmp/appimage-elf-probe
  printf "AI\002" | dd of=/tmp/appimage-elf-probe bs=1 seek=8 conv=notrunc status=none
  /tmp/appimage-elf-probe
'; then
  echo 'Cannot execute ARM64 AppImage ELF files in containers. Configure a static QEMU/binfmt handler that accepts the type-2 AppImage marker (see desktop/README.md).' >&2
  exit 1
fi
docker build --platform linux/amd64 --progress plain -t "$native_image" "$source_root/scripts/linux-appimage-builder"
docker build --platform linux/arm64 --progress plain -t "$arm_image" "$source_root/scripts/linux-appimage-builder"
docker build --platform linux/amd64 --progress plain -f "$source_root/scripts/linux-appimage-builder/cross.Dockerfile" \
  --build-arg "NATIVE_BUILDER=$native_image" --build-arg "ARM64_BUILDER=$arm_image" \
  -t "$cross_image" "$source_root/scripts/linux-appimage-builder"
# Pin runtime and compiler identities for the entire run even if another
# independent builder refreshes its tags later.
arm_image="$(docker image inspect "$arm_image" --format '{{.Id}}')"
cross_image="$(docker image inspect "$cross_image" --format '{{.Id}}')"
# Uploaded snapshots may belong to the SSH user rather than the unprivileged
# container builder. Only change ownership inside this run's source snapshot.
restore_owner=1
docker run --rm --label "$label" --platform linux/amd64 --user 0:0 \
  --mount "type=bind,src=$source_root,dst=/workspace" "$cross_image" chown -R 1000:1000 /workspace

common=(
  --rm --label "$label" --cpus "$jobs"
  --env "CARGO_BUILD_JOBS=$jobs"
  --mount "type=bind,src=$source_root,dst=/workspace"
  --mount "type=volume,src=$prefix-target,dst=/workspace/desktop/src-tauri/target"
)
build_security=(--cap-drop ALL --security-opt no-new-privileges)
if [[ -f "$run_dir/request.json" ]]; then
  common+=(--mount "type=bind,src=$run_dir/request.json,dst=/release-request.json,readonly")
else
  common+=(--env "DIAGNOSTIC_BUILD_ID=$(basename "$run_dir")")
fi
host_mounts=(
  --mount "type=volume,src=$prefix-cargo-registry,dst=/opt/cargo/registry"
  --mount "type=volume,src=$prefix-cargo-git,dst=/opt/cargo/git"
)
for architecture in native arm64; do
  mounts=("${common[@]}")
  for directory in node_modules frontend/node_modules desktop/node_modules; do
    mounts+=(--mount "type=volume,src=$prefix-$architecture-${directory//\//-},dst=/workspace/$directory")
  done
  mounts+=(--mount "type=volume,src=$prefix-$architecture-bun,dst=/home/builder/.bun"
    --mount "type=volume,src=$prefix-$architecture-cache,dst=/home/builder/.cache")
  if [[ "$architecture" = native ]]; then
    native_mounts=("${mounts[@]}" "${host_mounts[@]}")
    if [[ -n "$cargo_config" ]]; then
      [[ -f "$cargo_config" ]] || { echo 'Cargo configuration does not exist.' >&2; exit 1; }
      native_mounts+=(--mount "type=bind,src=$cargo_config,dst=/opt/cargo/config.toml,readonly")
    fi
    platform=linux/amd64; image="$cross_image"
  else
    arm_mounts=("${mounts[@]}")
    platform=linux/arm64; image="$arm_image"
  fi
  docker run --platform "$platform" --user 0:0 "${mounts[@]}" "$image" \
    chown 1000:1000 /workspace/node_modules /workspace/frontend/node_modules /workspace/desktop/node_modules
done

echo '[arm64-cross] ARM64 dependency checks'
docker run --platform linux/arm64 "${build_security[@]}" "${arm_mounts[@]}" "$arm_image" bash scripts/linux-appimage-builder/cross-prepare.sh checks
echo '[arm64-cross] Native x64 frontend and TypeScript checks'
docker run --platform linux/amd64 "${build_security[@]}" "${native_mounts[@]}" "$cross_image" bash scripts/linux-appimage-builder/cross-compile.sh prepare
echo '[arm64-cross] ARM64 bundled server'
docker run --platform linux/arm64 "${build_security[@]}" "${arm_mounts[@]}" "$arm_image" bash scripts/linux-appimage-builder/cross-prepare.sh server
echo '[arm64-cross] Native x64 compiler: ARM64 application tests'
docker run --platform linux/amd64 "${build_security[@]}" "${native_mounts[@]}" "$cross_image" bash scripts/linux-appimage-builder/cross-compile.sh tests
echo '[arm64-cross] Execute ARM64 application tests'
docker run --platform linux/arm64 "${build_security[@]}" "${arm_mounts[@]}" "$arm_image" bun scripts/linux-arm64-cross.ts run-tests
echo '[arm64-cross] Native x64 compiler: ARM64 release application'
docker run --platform linux/amd64 "${build_security[@]}" "${native_mounts[@]}" "$cross_image" bash scripts/linux-appimage-builder/cross-compile.sh app
echo '[arm64-cross] ARM64 AppImage packaging without recompilation'
docker run --platform linux/arm64 "${build_security[@]}" "${arm_mounts[@]}" "$arm_image" bash -ec '
  rm -rf desktop/src-tauri/target/aarch64-unknown-linux-gnu/release/bundle/appimage
  bun run --cwd desktop tauri:finalized bundle --target aarch64-unknown-linux-gnu --bundles appimage \
    --config src-tauri/tauri.server-bundle.conf.json --config src-tauri/tauri.release-updater.conf.json --ci
'
if [[ "$smoke" = 1 ]]; then
  echo '[arm64-cross] Offline ARM64 cross-user runtime smoke test'
  # unshare is needed for the existing isolated network-namespace smoke test.
  docker run --platform linux/arm64 --user 0:0 --network none --cap-add SYS_ADMIN \
    --security-opt seccomp=unconfined "${arm_mounts[@]}" "$arm_image" bash scripts/smoke-test-appimage.sh "$target_root/bundle/appimage"
fi
docker run --platform linux/arm64 --user 0:0 --network none "${arm_mounts[@]}" \
  --mount "type=bind,src=$run_dir/artifacts,dst=/artifacts" "$arm_image" bash -ec '
    cd desktop/src-tauri/target/aarch64-unknown-linux-gnu/release/bundle/appimage
    cp -- *.AppImage /artifacts/
    cp -- *.AppDir/usr/share/lumiverse/runtime-manifest.json /artifacts/
    bun -e '\''const manifest = await Bun.file("/artifacts/runtime-manifest.json").json(); if (manifest.architecture !== "arm64") throw new Error("AppImage runtime architecture mismatch");'\''
    if [[ -d /workspace/desktop/src-tauri/target/cargo-timings ]]; then
      cp -a /workspace/desktop/src-tauri/target/cargo-timings /artifacts/
    fi
    cd /artifacts; sha256sum -- *.AppImage > SHA256SUMS
    chmod -R a+rX /artifacts
  '
docker image inspect "$cross_image" --format '{{.Id}}' > "$run_dir/artifacts/compiler-image.txt"
docker image inspect "$arm_image" --format '{{.Id}}' > "$run_dir/artifacts/runtime-image.txt"
if [[ -f "$run_dir/build-source.json" ]]; then cp "$run_dir/build-source.json" "$run_dir/artifacts/"; fi
cp "$run_dir/build.log" "$run_dir/artifacts/"
echo "[arm64-cross] Verified artifacts: $run_dir/artifacts"
