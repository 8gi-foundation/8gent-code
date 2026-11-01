FROM oven/bun:1.4.3-slim AS base
WORKDIR /app

# Install curl for Ollama health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy vessel and its dependency on board-plane types
COPY packages/board-plane/types.ts packages/board-plane/types.ts
COPY packages/board-vessel/ packages/board-vessel/
# PII gate: inference.ts imports the local, dependency-free anonymizer so no
# officer-chat payload reaches the cloud model proxy with real identity in it.
COPY packages/permissions/pii-anonymizer.ts packages/permissions/pii-anonymizer.ts
COPY packages/permissions/owner-identity.ts packages/permissions/owner-identity.ts
# vessel-client.ts imports backoffDelay from here; without it the image fails at import.
COPY packages/tools/error-recovery.ts packages/tools/error-recovery.ts

# Create non-root user
# Debian slim base: groupadd/useradd (passwd) ship in the image; addgroup/adduser do not.
RUN groupadd --system --gid 1001 vessel && \
    useradd --system --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin vessel && \
    mkdir -p /data && chown vessel:vessel /data

USER vessel

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["bun", "run", "packages/board-vessel/vessel.ts"]
