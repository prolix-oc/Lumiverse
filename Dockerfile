# =============================================================================
# Lumiverse Backend — Multi-stage Docker Build
# =============================================================================
# Base: Debian slim (not Alpine — LanceDB requires glibc, no musl bindings)
# Bun is pinned to a stable multi-platform manifest digest. Do not use the
# floating `canary-slim` tag here: its lockfile behavior changed between
# scheduled builds and made `--frozen-lockfile` fail nondeterministically.
# Supports: linux/amd64, linux/arm64
# Keep COPY sources explicit: desktop/ is a native Tauri app and must not enter
# any image stage. Docker workflows also exclude it from their checkout.
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Build frontend (Vite + TypeScript)
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS frontend-build
WORKDIR /app/frontend

# Install dependencies first (cache layer)
COPY frontend/package.json frontend/bun.lock* ./
COPY frontend/patches/ ./patches/
COPY frontend/scripts/postinstall-bindings.cjs ./scripts/
# Fail loudly if the lockfile is missing or out of sync. Do NOT fall back to a
# non-frozen `bun install` — that silently re-resolves caret ranges and lets the
# dependency tree drift away from what was tested (see the kysely/better-auth
# DEFAULT_MIGRATION_LOCK_TABLE startup crash). The lockfile is committed.
RUN bun install --frozen-lockfile

# FRONTEND_REFRESH: cache-busting marker for the Vite build layer below. Mirrors
# the CA_REFRESH pattern in the runtime stage — bump (or pass via --build-arg)
# to force a fresh Vite bundle without invalidating the rest of the image.
# Source-file changes already invalidate the COPY layer below, so you only need
# to bump this when external inputs (e.g. environment-driven build behavior or
# upstream dependency hot-fixes pulled via `bun install`) demand a rebuild.
ARG FRONTEND_REFRESH=unset

# Build frontend
COPY frontend/ ./
# Browser-safe modules shared with the server must retain their repository-
# relative paths in this isolated stage (the backend source is not copied here).
COPY src/shared/ /app/src/shared/
COPY src/image-gen/image-input.ts /app/src/image-gen/
COPY user-docs/docs/ /app/user-docs/docs/
COPY developer-docs/docs/ /app/developer-docs/docs/
COPY src/utils/regex-action-signature.ts /app/src/utils/
COPY src/utils/theme-config.ts /app/src/utils/
COPY src/utils/theme-pack.ts /app/src/utils/
COPY src/utils/uuid.ts /app/src/utils/
RUN echo "frontend-refresh: ${FRONTEND_REFRESH}" && bun run build

# ---------------------------------------------------------------------------
# Stage 2: Install backend production dependencies
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS backend-deps

WORKDIR /app

COPY package.json bun.lock* ./
# Fail loudly if the lockfile is missing or out of sync — no silent re-resolve.
# (See the frontend stage above for the rationale.) The lockfile is committed.
RUN bun install --production --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 3: Runtime
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

# CA_REFRESH: cache-busting marker for the apt layer below. Bump (or pass via
# --build-arg) to force apt-get to re-fetch the `ca-certificates` package so the
# image's TLS trust store stays current. The scheduled CI job passes an ISO
# week value (e.g., "2026-W15") so this layer is rebuilt at least weekly, which
# keeps Mozilla root CA updates flowing through without requiring a Lumiverse
# version bump. Bun reads /etc/ssl/certs/ca-certificates.crt for outbound TLS,
# so keeping that file fresh is what fixes "unable to verify the first
# certificate" and similar failures talking to LLM / MCP / OAuth endpoints.
ARG CA_REFRESH=unset
RUN echo "ca-refresh: ${CA_REFRESH}" \
    && apt-get update \
    && apt-get install --no-install-recommends --no-install-suggests -y \
         git \
         ca-certificates \
         smartmontools \
    && update-ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*



LABEL org.opencontainers.image.title="Lumiverse"
LABEL org.opencontainers.image.description="AI chat application server"
LABEL org.opencontainers.image.source="https://github.com/prolix-oc/Lumiverse"

WORKDIR /app

# Backend dependencies
COPY --from=backend-deps /app/node_modules ./node_modules

# Built frontend assets + manifest used by spindle.version.getFrontend()
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
COPY --from=frontend-build /app/frontend/package.json ./frontend/package.json

# Backend source
COPY package.json ./
COPY src/ ./src/

# User guide docs for built-in help
COPY user-docs/ ./user-docs/

# Create data directory with correct ownership
RUN mkdir -p /app/data && chown -R bun:bun /app/data

# Environment defaults — all overridable via docker-compose
ENV NODE_ENV=production
ENV PORT=7860
ENV DATA_DIR=/app/data
ENV FRONTEND_DIR=/app/frontend/dist
# Docker containers sit behind reverse proxies / port mappings, so LAN IP
# auto-detection is meaningless. Default to accepting any origin; override
# with TRUSTED_ORIGINS for stricter setups.
ENV TRUST_ANY_ORIGIN=true

EXPOSE 7860

# Persist database, encryption identity, avatars, images, extensions
VOLUME /app/data

# Health check — hit the root (serves frontend) to verify the server is alive
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun run src/healthcheck.ts

# Run as non-root
USER bun

# Direct entry point — no interactive runner, logs go to stdout/stderr
CMD ["bun", "run", "src/index.ts"]
