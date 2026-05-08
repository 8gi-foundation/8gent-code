# Single image for daemon + bridges. Compose picks the entrypoint.
# Build context is the repo root; this Dockerfile lives at infra/hetzner/Dockerfile.
FROM oven/bun:1 AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps in a layer that only invalidates when manifests change.
COPY package.json bun.lock* ./
RUN bun install --production || bun install

# Copy the runtime code. The daemon and bridge import from packages/* and
# need workspace manifests resolved, so we ship the whole package tree.
COPY tsconfig.json ./
COPY packages/ packages/

# Writable runtime dirs. /var/lib/8gent is bind-mounted in compose.
RUN mkdir -p /var/lib/8gent /tmp/8gent-work
ENV EIGHT_HOME=/var/lib/8gent

EXPOSE 18789

# Default: daemon. Compose overrides for the bridge services.
CMD ["bun", "run", "packages/daemon/index.ts"]
