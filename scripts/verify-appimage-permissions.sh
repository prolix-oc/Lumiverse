#!/usr/bin/env bash

set -euo pipefail

appdir="${1:?usage: verify-appimage-permissions.sh <AppDir-or-extracted-AppImage>}"
if [[ ! -d "$appdir" ]]; then
  echo "AppImage root does not exist: $appdir" >&2
  exit 1
fi

# SquashFS mounts can retain the packaging user's ownership. Checking -x as
# that same user misses Tauri's cached 0770 launcher; check the other-user bits.
invalid=()
while IFS= read -r -d '' candidate; do
  invalid+=("$candidate")
done < <(find "$appdir" \
  \( \( -type d ! -perm -0005 \) -o \
  \( -type f ! -perm -0004 \) -o \
  \( -type f \( -perm -0100 -o -perm -0010 \) ! -perm -0001 \) \) -print0)

for entrypoint in AppRun AppRun.wrapped usr/bin/lumiverse-tray \
  usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner; do
  launcher="$appdir/$entrypoint"
  if [[ ! -f "$launcher" ]] || [[ -n "$(find -L "$launcher" -maxdepth 0 ! -perm -0005 -print)" ]]; then
    invalid+=("$launcher (must be readable and executable for everyone)")
  fi
done

if [[ ${#invalid[@]} -gt 0 ]]; then
  printf 'AppImage contains files inaccessible to other users:\n' >&2
  printf '  %s\n' "${invalid[@]}" >&2
  exit 1
fi

echo "Verified AppImage files and launchers are readable and executable for other users."
