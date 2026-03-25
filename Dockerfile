FROM oven/bun:latest AS base

WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json bun.lock* ./

# Copy daemon package and its workspace dependencies
COPY packages/daemon/ packages/daemon/
COPY packages/eight/ packages/eight/
COPY packages/memory/ packages/memory/
COPY packages/providers/ packages/providers/
COPY packages/tools/ packages/tools/
COPY packages/permissions/ packages/permissions/
COPY packages/self-autonomy/ packages/self-autonomy/
COPY packages/validation/ packages/validation/
COPY packages/orchestration/ packages/orchestration/
COPY packages/ast-index/ packages/ast-index/
COPY packages/proactive/ packages/proactive/

# Install dependencies
RUN bun install --frozen-lockfile || bun install

# Create data directory
RUN mkdir -p /root/.8gent

# Expose daemon port
EXPOSE 18789

# Health check - hit the WebSocket gateway
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:18789').catch(() => process.exit(1))" || exit 1

# Run the daemon
CMD ["bun", "run", "packages/daemon/index.ts"]
