#### 1. Create a new Space

1. Go to [huggingface.co/new-space](https://huggingface.co/new-space).
2. Give it a name, set **Space SDK** to **Docker**, and set **Visibility** to *Public* or *Private*.
3. Click **Create Space**.

#### 2. Add persistent storage

In your Space's **Settings → Persistent storage**, attach a storage bucket and mount it at `/app/data`.

#### 3. Add the Dockerfile

In the **Files** tab of your Space, create a file named `Dockerfile` with the following contents:

```dockerfile
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  git ca-certificates curl sqlite3 rsync python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG LUMIVERSE_REPO=https://github.com/prolix-oc/Lumiverse.git
ARG LUMIVERSE_REF=staging
RUN git clone --depth 1 --branch "${LUMIVERSE_REF}" "${LUMIVERSE_REPO}" .

RUN rm -f package-lock.json && bun install --production

WORKDIR /app/frontend
RUN rm -f package-lock.json && bun install && bun run build
RUN printf "self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));\n" > /app/frontend/dist/sw.js
RUN test -f /app/frontend/dist/index.html

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7860
ENV DATA_DIR=/app/data
ENV FRONTEND_DIR=/app/frontend/dist
ENV TRUST_ANY_ORIGIN=true
ENV OWNER_PASSWORD=admin123

RUN cat > /app/start.sh <<'SH'
#!/usr/bin/env sh
set -eu
export DATA_DIR="${DATA_DIR:-/app/data}"
exec bun run scripts/runner.ts
SH

RUN chmod +x /app/start.sh

USER root
RUN mkdir -p /app/data && chown -R bun:bun /app/data

EXPOSE 7860
VOLUME /app/data

USER bun
CMD ["/app/start.sh"]
```

#### 4. Set your admin password

Before the Space builds, go to **Settings → Variables and secrets** and add a secret:

| Name | Value |
|------|-------|
| `OWNER_PASSWORD` | *your chosen password* |

This overrides the `admin123` default baked into the Dockerfile. **Do not skip this step on a public Space.**

#### 5. Open the Space

Once the build finishes (~3–5 min on the free tier), click **Open in new tab** (or visit `https://<your-username>-<space-name>.hf.space`). Log in with username `admin` and the password you set.

## First-Run Setup

On first launch, the setup wizard walks you through:

1. **Admin account** — username and password for the owner account
2. **Server port** — defaults to `7860`
3. **Extension storage** — disk budget for Spindle extension data pools
4. **Disk health monitoring** — installs smartmontools through the detected system package manager when possible
5. **Identity file** — auto-generated encryption identity (`data/lumiverse.identity`)

The wizard produces a `.env` file and the identity file. Both are required to run the server.

> **Important:** Keep `data/lumiverse.identity` safe. It holds the encryption key for all secrets. If lost, encrypted data cannot be recovered.
