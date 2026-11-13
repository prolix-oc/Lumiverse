#!/usr/bin/env bash
set -euo pipefail
run_dir="${1:?run directory}"
cache_dir="${2:?cache directory}"
jobs="${3:?parallel jobs}"
smoke="${4:-0}"
arch="${5:-x64}"
if [[ "${6:-0}" = 1 ]]; then
  [[ "$arch" = arm64 ]] || { echo 'Cross-compilation requires --arch arm64.' >&2; exit 1; }
  exec bash "$run_dir/source/scripts/linux-appimage-builder/run-cross.sh" "$run_dir" "$cache_dir" "$jobs" "$smoke"
fi
case "$arch" in
  x64) platform=linux/amd64; cache_suffix= ;;
  arm64) platform=linux/arm64; cache_suffix=-arm64 ;;
  *) echo "Unsupported AppImage architecture: $arch" >&2; exit 1 ;;
esac
image="lumiverse-appimage-builder:ubuntu22.04$cache_suffix"
# Retain existing x64 caches; ARM64 tools and artifacts never share them.
volume_prefix="lumiverse-appimage$cache_suffix"
source_owner="$(stat -c '%u:%g' "$run_dir/source")"
restore_owner=0
label="io.lumiverse.release-run=${GITHUB_RUN_ID:-diagnostic-$(basename "$run_dir")}"
exec 9>"$cache_dir/build$cache_suffix.lock"
flock -n 9 || { echo 'Another remote AppImage build is using these caches.' >&2; exit 1; }

# All mutations are confined to the dedicated uploaded snapshot and Docker
# caches. No existing remote checkout, GitHub release, or Actions run is used.
exec > >(tee "$run_dir/build.log") 2>&1
cleanup() {
  local result=$?
  mapfile -t remaining < <(docker ps -q --filter "label=$label")
  if ((${#remaining[@]})); then docker stop --timeout 10 "${remaining[@]}" || true; fi
  if [[ "$restore_owner" = 1 && "$source_owner" != 1000:1000 ]]; then
    docker run --rm --label "$label" --platform "$platform" --user 0:0 --network none \
      --mount "type=bind,src=$run_dir/source,dst=/workspace" "$image" \
      chown -R "$source_owner" /workspace || result=1
  fi
  printf '%s\n' "$result" > "$run_dir/exit-status"
  exit "$result"
}
trap cleanup EXIT
# Fail before installing toolchains if this host cannot execute the target.
# Host-level binfmt registration is an explicit administrator setup step.
if ! docker run --rm --label "$label" --pull=always --platform "$platform" ubuntu:22.04 /bin/true; then
  echo "Cannot execute $platform containers. Configure QEMU/binfmt on the build host first (see desktop/README.md)." >&2
  exit 1
fi
if [[ "$arch" = arm64 ]] && ! docker run --rm --label "$label" --platform "$platform" ubuntu:22.04 bash -ec '
  cp /bin/true /tmp/appimage-elf-probe
  printf "AI\002" | dd of=/tmp/appimage-elf-probe bs=1 seek=8 conv=notrunc status=none
  /tmp/appimage-elf-probe
'; then
  echo 'Cannot execute ARM64 AppImage ELF files in containers. Configure a static QEMU/binfmt handler that accepts the type-2 AppImage marker (see desktop/README.md).' >&2
  exit 1
fi
docker build --platform "$platform" --progress plain -t "$image" "$run_dir/source/scripts/linux-appimage-builder"
restore_owner=1
docker run --rm --label "$label" --platform "$platform" --user 0:0 --mount "type=bind,src=$run_dir/source,dst=/workspace" \
  "$image" chown -R 1000:1000 /workspace

volumes=(
  --mount "type=volume,src=$volume_prefix-cargo-registry,dst=/opt/cargo/registry"
  --mount "type=volume,src=$volume_prefix-cargo-git,dst=/opt/cargo/git"
  --mount "type=volume,src=$volume_prefix-target,dst=/workspace/desktop/src-tauri/target"
  --mount "type=volume,src=$volume_prefix-bun,dst=/home/builder/.bun"
  --mount "type=volume,src=$volume_prefix-cache,dst=/home/builder/.cache"
)
docker run --rm --label "$label" --platform "$platform" --cap-drop ALL --security-opt no-new-privileges --cpus "$jobs" \
  --env "LUMIVERSE_BUILD_ARCH=$arch" \
  --env "CARGO_BUILD_JOBS=$jobs" --env "DIAGNOSTIC_BUILD_ID=$(basename "$run_dir")" \
  --mount "type=bind,src=$run_dir/source,dst=/workspace" "${volumes[@]}" \
  "$image" bash scripts/linux-appimage-builder/build.sh

# Smoke-test without external networking, as the unprivileged build user.
# The stronger cross-user/unshare release smoke test remains in CI.
if [[ "$smoke" == 1 ]]; then
  docker run --rm --label "$label" --platform "$platform" --network none --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,src=$run_dir/source,dst=/workspace" "${volumes[@]}" \
    "$image" bash scripts/linux-appimage-builder/smoke.sh
fi

mkdir -p "$run_dir/artifacts"
# The target tree is a Docker volume, so collect it through the container.
docker run --rm --label "$label" --platform "$platform" --user 0:0 --network none \
  --mount "type=bind,src=$run_dir/artifacts,dst=/artifacts" "${volumes[@]}" \
  "$image" bash -c 'set -eu; cd /workspace/desktop/src-tauri/target/release/bundle/appimage; cp -- *.AppImage /artifacts/; cp -- *.AppDir/usr/share/lumiverse/runtime-manifest.json /artifacts/; cd /artifacts; sha256sum -- *.AppImage > SHA256SUMS'
docker run --rm --label "$label" --platform "$platform" --network none \
  --env "LUMIVERSE_BUILD_ARCH=$arch" --mount "type=bind,src=$run_dir/artifacts,dst=/artifacts,readonly" \
  "$image" bun -e 'const manifest = await Bun.file("/artifacts/runtime-manifest.json").json(); if (manifest.architecture !== process.env.LUMIVERSE_BUILD_ARCH) throw new Error("AppImage runtime architecture mismatch");'
cp "$run_dir/build-source.json" "$run_dir/artifacts/"
docker image inspect "$image" --format '{{.Id}}' > "$run_dir/artifacts/builder-image.txt"
cp "$run_dir/build.log" "$run_dir/artifacts/"
printf '[remote-build] AppImage and runtime provenance ready in %s/artifacts\n' "$run_dir"
