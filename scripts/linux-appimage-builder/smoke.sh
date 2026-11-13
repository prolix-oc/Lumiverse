#!/usr/bin/env bash
set -euo pipefail
bundle=/workspace/desktop/src-tauri/target/release/bundle/appimage
images=("$bundle"/*.AppImage)
test "${#images[@]}" = 1
smoke_home="$(mktemp -d)"
trap 'rm -rf "$smoke_home"' EXIT
mkdir -p "$smoke_home/host tools" "$smoke_home/runtime"
chmod 700 "$smoke_home/runtime"
cat > "$smoke_home/host tools/xdg-open" <<'LAUNCHER'
#!/usr/bin/env bash
set -eu
test "$1" = https://example.invalid/lumiverse-desktop-smoke
test -z "${LD_LIBRARY_PATH+x}"
test -z "${APPDIR+x}"
printf 'host environment restored\n' > "$HOME/host-launch.ok"
LAUNCHER
chmod 755 "$smoke_home/host tools/xdg-open"
log="$smoke_home/smoke.log"
env -i HOME="$smoke_home" PATH="$smoke_home/host tools:/usr/bin:/bin" LANG=C.UTF-8 \
  XDG_RUNTIME_DIR="$smoke_home/runtime" APPIMAGE_EXTRACT_AND_RUN=1 \
  LUMIVERSE_DESKTOP_SMOKE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  timeout --kill-after=5s 60s dbus-run-session -- xvfb-run -a \
  bash scripts/appimage-smoke-interact.sh "${images[0]}" > "$log" 2>&1 || { cat "$log"; exit 1; }
cat "$log"
grep -Fq '[desktop-smoke] trusted click, typing, scrolling and host URL dispatch passed' "$log"
test -f "$smoke_home/host-launch.ok"
