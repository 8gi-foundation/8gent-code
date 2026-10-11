FROM oven/bun:1.2-alpine

WORKDIR /app

RUN apk add --no-cache curl ca-certificates

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${PORT}/health || exit 1

CMD ["bun", "run", "src/index.ts"]
