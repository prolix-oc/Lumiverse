FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH
ARG BUN_VERSION=1.4.4
ARG RUST_VERSION=1.95.0
ARG NODE_VERSION=22.16.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl file git unzip xz-utils pkg-config sudo \
    libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
    librsvg2-dev libxdo-dev patchelf xdg-utils squashfs-tools \
    dbus-x11 xauth xvfb xdotool libgl1-mesa-dri libegl1 \
    gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
RUN curl --fail --silent --show-error https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain "$RUST_VERSION" \
    && rm /tmp/rustup.sh

RUN case "$TARGETARCH" in amd64) bun_arch=x64; node_arch=x64 ;; arm64) bun_arch=aarch64; node_arch=arm64 ;; *) exit 1 ;; esac \
    && curl --fail --location --silent --show-error \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip" -o /tmp/bun.zip \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -m 755 /tmp/bun/bun-linux-*/bun /usr/local/bin/bun \
    && curl --fail --location --silent --show-error \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm -rf /tmp/bun /tmp/bun.zip /tmp/node.tar.xz \
    && test "$(bun --version)" = "$BUN_VERSION"

RUN groupadd --gid 1000 builder && useradd --uid 1000 --gid 1000 --create-home builder \
    && mkdir -p /opt/cargo/registry /opt/cargo/git /home/builder/.bun /home/builder/.cache \
      /workspace/desktop/src-tauri/target \
    && chown -R builder:builder /opt/cargo/registry /opt/cargo/git /home/builder /workspace

ENV PATH=/opt/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    HOME=/home/builder APPIMAGE_EXTRACT_AND_RUN=1
USER builder
WORKDIR /workspace
