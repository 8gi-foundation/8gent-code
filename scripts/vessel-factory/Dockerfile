# 8GI Vessel Factory Dockerfile
# Shared base for all 8 officer vessels.
# No Ollama - inference via model-proxy.
# Target: ~60MB image, 256MB RAM at runtime.

FROM oven/bun:1.2-alpine AS base

WORKDIR /app

# Install only what we need: curl for health probes, ca-certs for TLS
RUN apk add --no-cache curl ca-certificates

# Copy lockfile + package manifest first for layer caching
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Runtime config injected by fly.toml [env] section:
#   VESSEL_CODE      (8EO, 8TO, 8PO, ...)
#   VESSEL_NAME      (AI James, Rishi, Samantha, ...)
#   VESSEL_TITLE     (Executive Officer, ...)
#   VESSEL_SOUL      (officer personality prompt)
#   VESSEL_CATCHPHRASE
#   MODEL_PROXY_URL  (http://8gi-model-proxy.internal:3200)
#   CONTROL_PLANE_URL (wss://8gi-board-plane.fly.dev)
#   TELEGRAM_BOT_TOKEN
#   JAMES_TELEGRAM_CHAT_ID
#   PORT             (default 8080)

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${PORT}/health || exit 1

CMD ["bun", "run", "src/daemon.ts"]
