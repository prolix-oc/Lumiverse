# Both parent images are built from this directory's Dockerfile, using the
# same Ubuntu 22.04 packages and pinned Rust/Bun versions as native releases.
ARG ARM64_BUILDER=lumiverse-appimage-builder:ubuntu22.04-arm64
ARG NATIVE_BUILDER=lumiverse-appimage-builder:ubuntu22.04
FROM --platform=linux/arm64 ${ARM64_BUILDER} AS arm64-runtime
FROM --platform=linux/amd64 ${NATIVE_BUILDER}

USER root
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
    && rm -rf /var/lib/apt/lists/*
RUN rustup target add aarch64-unknown-linux-gnu

# Copy the exact ARM64 runtime's headers, shared libraries and pkg-config
# metadata. No host graphics or libc libraries enter the target link.
COPY --from=arm64-runtime /usr/include/ /opt/arm64-sysroot/usr/include/
COPY --from=arm64-runtime /usr/lib/ /opt/arm64-sysroot/usr/lib/
COPY --from=arm64-runtime /usr/share/pkgconfig/ /opt/arm64-sysroot/usr/share/pkgconfig/
RUN ln -s usr/lib /opt/arm64-sysroot/lib
# Debian development links can point to /lib with absolute paths. Rebase them
# so the linker follows the ARM64 sysroot instead of the native filesystem.
RUN python3 - <<'PY'
import os
from pathlib import Path

root = Path('/opt/arm64-sysroot')
for link in root.rglob('*'):
    if link.is_symlink():
        target = os.readlink(link)
        if target.startswith('/'):
            link.unlink()
            link.symlink_to(os.path.relpath(root / target.lstrip('/'), link.parent))
PY
COPY cross-linker.sh /usr/local/bin/lumiverse-aarch64-linux-gnu-gcc
RUN chmod 755 /usr/local/bin/lumiverse-aarch64-linux-gnu-gcc \
    && ln -s lumiverse-aarch64-linux-gnu-gcc /usr/local/bin/lumiverse-aarch64-linux-gnu-g++

# Target-scoped pkg-config settings preserve native build-script dependencies.
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=lumiverse-aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=lumiverse-aarch64-linux-gnu-gcc \
    CXX_aarch64_unknown_linux_gnu=lumiverse-aarch64-linux-gnu-g++ \
    AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar \
    PKG_CONFIG_ALLOW_CROSS=1 \
    PKG_CONFIG_SYSROOT_DIR_aarch64_unknown_linux_gnu=/opt/arm64-sysroot \
    PKG_CONFIG_LIBDIR_aarch64_unknown_linux_gnu=/opt/arm64-sysroot/usr/lib/aarch64-linux-gnu/pkgconfig:/opt/arm64-sysroot/usr/share/pkgconfig
# Catch an escaping development symlink before compiling the Rust dependency
# tree: D-Bus must link dynamically against the target runtime's shared library.
RUN printf '%s\n' '#include <dbus/dbus.h>' \
      'int main(void) { int a, b, c; dbus_get_version(&a, &b, &c); return a == 0; }' > /tmp/dbus-cross-probe.c \
    && lumiverse-aarch64-linux-gnu-gcc /tmp/dbus-cross-probe.c \
      $(PKG_CONFIG_SYSROOT_DIR=/opt/arm64-sysroot \
        PKG_CONFIG_LIBDIR=/opt/arm64-sysroot/usr/lib/aarch64-linux-gnu/pkgconfig \
        pkg-config --cflags --libs dbus-1) -o /tmp/dbus-cross-probe \
    && aarch64-linux-gnu-readelf -d /tmp/dbus-cross-probe | grep -F 'Shared library: [libdbus-1.so.3]' \
    && rm /tmp/dbus-cross-probe.c /tmp/dbus-cross-probe
USER builder
