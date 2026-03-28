FROM oven/bun:1.1-slim AS base
WORKDIR /app

# Install curl for Ollama health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy vessel and its dependency on board-plane types
COPY packages/board-plane/types.ts packages/board-plane/types.ts
COPY packages/board-vessel/ packages/board-vessel/

# Create non-root user
RUN addgroup --system --gid 1001 vessel && \
    adduser --system --uid 1001 --gid 1001 vessel

USER vessel

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["bun", "run", "packages/board-vessel/vessel.ts"]
