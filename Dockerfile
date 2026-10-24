# Board Vessel - Full agent loop for autonomous implementation
# Option A: proven agent loop, model-proxy for pre-processing inference
FROM oven/bun:1 AS deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production || bun install

FROM oven/bun:1-slim AS base
WORKDIR /app

# git applies the patches a cell's /selfimprove round proposes (packages/self-autonomy/selfimprove.ts).
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Copy deps
COPY --from=deps /app/node_modules ./node_modules

# Copy all packages (agent loop needs most of them)
COPY package.json tsconfig.json ./
COPY packages/ packages/

# The 8gent CLI (a cell runs `bun run /app/bin/8gent.ts selfimprove`) and the helpers the frozen checks import.
COPY bin/ bin/
COPY tests/ tests/

# Copy harness scripts + benchmarks (kernel depends on model-router)
COPY scripts/nightly-train.ts scripts/nightly-train.ts
COPY scripts/board-vessel/ scripts/board-vessel/
COPY scripts/cell-sandbox-proof.sh scripts/cell-sandbox-proof.sh
COPY benchmarks/ benchmarks/

# Writable tmp for agent workdirs
RUN mkdir -p /tmp/8gent-work /root/.8gent/sessions

# The user a /selfimprove round runs model-written code as (selfimprove.ts linuxSandbox): no home, no shell.
# /root stays root-only so that user cannot reach the cell's state, key file or ledger, and the genome in
# /app is not writable by it. Proof: scripts/cell-sandbox-proof.sh (CI: .github/workflows/cell-image.yml).
RUN useradd --uid 1002 --no-create-home --shell /usr/sbin/nologin cellrun \
 && chmod 700 /root \
 && chmod -R go-w /app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/bin/sh", "/app/scripts/board-vessel/entrypoint.sh"]
