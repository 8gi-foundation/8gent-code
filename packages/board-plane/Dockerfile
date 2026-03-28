FROM oven/bun:1.1-slim AS base
WORKDIR /app

# Install only what we need
COPY packages/board-plane/ packages/board-plane/

# Create non-root user
RUN addgroup --system --gid 1001 plane && \
    adduser --system --uid 1001 --gid 1001 plane && \
    mkdir -p /data && chown plane:plane /data

USER plane

EXPOSE 3100
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3100/health || exit 1

CMD ["bun", "run", "packages/board-plane/main.ts"]
