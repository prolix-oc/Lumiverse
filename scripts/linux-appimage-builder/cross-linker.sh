#!/usr/bin/env bash
set -euo pipefail
case "$0" in
  *g++) exec aarch64-linux-gnu-g++ --sysroot=/opt/arm64-sysroot "$@" ;;
  *) exec aarch64-linux-gnu-gcc --sysroot=/opt/arm64-sysroot "$@" ;;
esac
