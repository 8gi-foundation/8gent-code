FROM oven/bun:1 AS base
RUN apt-get update && apt-get install -y curl git && rm -rf /var/lib/apt/lists/*

# Install Ollama
RUN curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh && sh /tmp/ollama-install.sh

WORKDIR /app

# Copy the board vessel daemon
COPY scripts/board-vessel/daemon.ts scripts/board-vessel/daemon.ts
COPY scripts/board-vessel/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
