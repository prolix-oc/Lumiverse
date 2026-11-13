#!/usr/bin/env bash
set -euo pipefail
"$1" &
app_pid=$!
trap 'kill "$app_pid" 2>/dev/null || true' EXIT
window=""
for _ in {1..120}; do
  window="$(xdotool search --onlyvisible --name '^Lumiverse Desktop Smoke$' 2>/dev/null | head -n 1 || true)"
  [[ -n "$window" ]] && break
  kill -0 "$app_pid" 2>/dev/null || { wait "$app_pid"; exit 1; }
  sleep 0.25
done
[[ -n "$window" ]] || { echo 'WebKit interaction window did not appear' >&2; exit 1; }
# Xvfb has no window manager. Raise the fixture as well as focusing it; the
# first-launch connection dialog can otherwise cover it or steal focus while
# typing. Retry only when that focus loss is observed, clearing partial input.
typed=0
for attempt in {1..5}; do
  xdotool windowraise "$window" windowfocus --sync "$window"
  xdotool mousemove --window "$window" 100 100 click 1
  xdotool key --clearmodifiers ctrl+a
  # Exercise normal typing rather than a 300-word/minute injection burst;
  # emulated X11/WebKit processes need time to handle each native key event.
  xdotool type --clearmodifiers --delay 200 'lumiverse-smoke'
  if [[ "$(xdotool getwindowfocus)" = "$window" ]]; then
    typed=1
    break
  fi
  printf '[smoke-driver] focus changed during typing (attempt %s); retrying\n' "$attempt"
  sleep 0.25
done
[[ "$typed" = 1 ]] || { echo 'WebKit interaction window could not retain keyboard focus' >&2; exit 1; }
xdotool windowraise "$window"
xdotool mousemove --window "$window" 100 160 click 1
xdotool mousemove --window "$window" 100 300 click --repeat 6 --delay 80 5
wait "$app_pid"
