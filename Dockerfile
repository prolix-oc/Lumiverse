# =============================================================================
# Lumiverse Backend — Multi-stage Docker Build
# =============================================================================
# Base: Debian slim (not Alpine — LanceDB requires glibc, no musl bindings)
# Supports: linux/amd64, linux/arm64
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Build frontend (Vite + TypeScript)
# ---------------------------------------------------------------------------
FROM oven/bun:1-slim AS frontend-build
WORKDIR /app/frontend

# Install dependencies first (cache layer)
COPY frontend/package.json frontend/bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Build frontend
COPY frontend/ ./
RUN bun run build

# ---------------------------------------------------------------------------
# Stage 2: Install backend production dependencies
# ---------------------------------------------------------------------------
FROM oven/bun:1-slim AS backend-deps

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production

# ---------------------------------------------------------------------------
# Stage 3: Runtime
# ---------------------------------------------------------------------------
FROM oven/bun:1-slim

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
    && update-ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*



LABEL org.opencontainers.image.title="Lumiverse"
LABEL org.opencontainers.image.description="AI chat application server"
LABEL org.opencontainers.image.source="https://github.com/prolix-oc/Lumiverse"

WORKDIR /app

# Backend dependencies
COPY --from=backend-deps /app/node_modules ./node_modules

# Built frontend
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Backend source
COPY package.json ./
COPY src/ ./src/

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
  CMD bun -e "fetch('http://localhost:' + (Bun.env.PORT || '7860')).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run as non-root
USER bun

# Direct entry point — no interactive runner, logs go to stdout/stderr
CMD ["bun", "run", "src/index.ts"]
