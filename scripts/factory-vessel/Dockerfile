FROM oven/bun:1 AS base
RUN apt-get update && apt-get install -y curl git zstd && rm -rf /var/lib/apt/lists/*

# Install Ollama
RUN curl -fsSL https://ollama.com/install.sh | sh

# Install gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy factory scripts and queue
COPY scripts/utility-factory.ts scripts/utility-factory.ts
COPY scripts/utility-queue.json scripts/utility-queue.json

# Entrypoint that starts Ollama, pulls model, runs factory
COPY scripts/factory-vessel/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
