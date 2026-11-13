#!/usr/bin/env bash
# Lumiverse pre-hook launcher v1
# Runs before linuxdeploy's hooks. Preserve unset versus empty values, including
# paths with spaces, without serializing the user's full environment to disk.
set -eu
for key in PATH LD_LIBRARY_PATH LD_PRELOAD XDG_DATA_DIRS XDG_CONFIG_DIRS \
  GTK_PATH GTK_EXE_PREFIX GTK_DATA_PREFIX GTK_IM_MODULE GTK_IM_MODULE_FILE \
  GIO_MODULE_DIR GIO_EXTRA_MODULES GSETTINGS_SCHEMA_DIR \
  GST_PLUGIN_PATH GST_PLUGIN_PATH_1_0 GST_PLUGIN_SYSTEM_PATH GST_PLUGIN_SYSTEM_PATH_1_0 \
  GST_PLUGIN_SCANNER GST_PLUGIN_SCANNER_1_0 GST_REGISTRY GST_REGISTRY_1_0 \
  WEBKIT_EXEC_PATH WEBKIT_INJECTED_BUNDLE_PATH GDK_BACKEND \
  __NV_DISABLE_EXPLICIT_SYNC WEBKIT_DISABLE_DMABUF_RENDERER \
  WEBKIT_DISABLE_COMPOSITING_MODE LIBGL_ALWAYS_SOFTWARE GALLIUM_DRIVER; do
  if [[ ${!key+x} ]]; then
    export "LUMIVERSE_HOST_${key}_SET=1" "LUMIVERSE_HOST_${key}=${!key}"
  else
    export "LUMIVERSE_HOST_${key}_SET=0"
    unset "LUMIVERSE_HOST_${key}"
  fi
done
export LUMIVERSE_HOST_ENV_CAPTURED=1
appdir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$appdir/AppRun.lumiverse-inner" "$@"
