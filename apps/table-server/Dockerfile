# Standalone Table server. Build from the repo root:
#   docker build -f apps/table-server/Dockerfile -t 8gent-table-server .
# The image holds one bundled file and no package manager install step: the
# server needs only bun:sqlite and node builtins.

# oven/bun:1.4.2-slim, pinned by its multi-arch index digest (fetched 14 Nov 2026).
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS build
WORKDIR /src
COPY packages/ packages/
COPY apps/table-server/src/ apps/table-server/src/
RUN bun build apps/table-server/src/main.ts --target=bun --outfile=/out/table-server.js \
 && ! grep -q "child_process" /out/table-server.js

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
WORKDIR /app
COPY --from=build /out/table-server.js /app/table-server.js
# Numeric uid/gid, so secret ownership does not depend on /etc/passwd in the base
# image. Upstream's Dockerfile creates "bun" as 1000:1000 too (dockerhub/debian-slim).
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000

# Inside the container's own network namespace the server must listen on all
# of its interfaces for a published port to reach it. What the HOST exposes
# is decided by the compose publish address (192.168.218.1 only), because
# Docker-published ports bypass ufw.
ENV EIGHT_DATA_DIR=/data \
    TABLE_BIND=0.0.0.0 \
    TABLE_PORT=18789 \
    TABLE_TOKENS_FILE=/run/table/tokens

VOLUME ["/data"]
EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:18789/healthz'); process.exit(r.ok ? 0 : 1)"]

# Run it with a read-only root filesystem, every capability dropped and
# no-new-privileges. A Dockerfile cannot set these; the real compose file on
# 8gi-ops MUST (compose.example.yml shows them):
#   read_only: true
#   cap_drop: [ALL]
#   security_opt: ["no-new-privileges:true"]
#   tmpfs: [/tmp]
ENTRYPOINT ["bun", "/app/table-server.js"]
