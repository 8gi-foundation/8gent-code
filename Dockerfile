# Board Vessel - Full agent loop for autonomous implementation
# Option A: proven agent loop, model-proxy for pre-processing inference
FROM oven/bun:1 AS deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production || bun install

FROM oven/bun:1-slim AS base
WORKDIR /app

# Copy deps
COPY --from=deps /app/node_modules ./node_modules

# Copy all packages (agent loop needs most of them)
COPY package.json tsconfig.json ./
COPY packages/ packages/

# Copy harness scripts + benchmarks (kernel depends on model-router)
COPY scripts/nightly-train.ts scripts/nightly-train.ts
COPY scripts/board-vessel/ scripts/board-vessel/
COPY benchmarks/ benchmarks/

# Writable tmp for agent workdirs
RUN mkdir -p /tmp/8gent-work /root/.8gent/sessions

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/bin/sh", "/app/scripts/board-vessel/entrypoint.sh"]
