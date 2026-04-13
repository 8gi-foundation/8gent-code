FROM oven/bun:1.2-alpine

WORKDIR /app

# Copy source
COPY package.json .
COPY src/ ./src/

# No install needed - zero npm deps

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
