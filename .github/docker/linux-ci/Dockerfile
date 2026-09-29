# Linux CI image for .github/workflows/linux-docker.yml.
#
# Base: oven/bun:1 pinned by digest (Debian 13 trixie, Bun 1.4.2 at this pin).
# Bump deliberately:
#   docker pull oven/bun:1 && docker image inspect oven/bun:1 --format '{{index .RepoDigests 0}}'
# then update the digest below.
FROM oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895

# git      - tests that create or read git repos.
# ripgrep  - the locate tool shells out to rg.
# python3, make, g++ - node-gyp builds for native deps that ship no Linux
#            prebuild (node-pty, tree-sitter-typescript).
# procps   - pkill/ps; harness tests clean up fixture processes with pkill.
# libsecret-tools, gnome-keyring, dbus - a real Secret Service so the
#            Linux-only LibsecretVault tests (packages/secrets) run instead of
#            skipping; run.sh starts a session bus and unlocks a throwaway keyring.
# xz-utils - to unpack the Node tarball below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep procps python3 make g++ libsecret-tools gnome-keyring dbus dbus-daemon xz-utils curl ca-certificates \
 && apt-get clean && find /var/lib/apt/lists -type f -delete

# A real Node, for two reasons:
#  - packages/terminal-tab/pty-bridge.cjs runs node-pty under Node (its native
#    FD watcher does not run under Bun); the base image's `node` is only
#    Bun's fallback shim.
#  - bun runs native install scripts via node-gyp@latest, whose undici needs a
#    newer Node than Debian's 20.19 (webidl.util.markAsUncloneable).
# 22.14.0 matches MANAGED_NODE_VERSIONS in packages/terminal-tab/find-node.ts.
ARG NODE_VERSION=22.14.0
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-arm64}" in \
      arm64) a=arm64; sha=08bfbf538bad0e8cbb0269f0173cca28d705874a67a22f60b57d99dc99e30050 ;; \
      amd64) a=x64;   sha=69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec ;; \
      *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
    esac; \
    f="node-v${NODE_VERSION}-linux-${a}.tar.xz"; \
    curl -fsSLo "/tmp/$f" "https://nodejs.org/dist/v${NODE_VERSION}/$f"; \
    echo "$sha  /tmp/$f" | sha256sum -c -; \
    tar -xJf "/tmp/$f" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE; \
    unlink "/tmp/$f"; \
    /usr/local/bin/node --version

# A pinned node-gyp on PATH. Without one, bun falls back to `bunx
# node-gyp@latest` per native package, and the parallel install scripts race
# to populate the same /tmp/bunx-<uid>-node-gyp@latest directory (seen:
# "Cannot find module './api-connect'" building better-sqlite3).
ARG NODE_GYP_VERSION=12.4.0
RUN npm install -g --no-fund --no-audit "node-gyp@${NODE_GYP_VERSION}" && node-gyp --version

# Real Node ahead of Bun's fallback shim (which is last on PATH already).
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

# Non-root: tests that expect permission errors (e.g. an unwritable
# directory) only mean something when the runner is not root.
RUN useradd --create-home --uid 1001 --shell /bin/bash ci \
 && mkdir -p /work /home/ci/.bun/install/cache \
 && chown -R ci:ci /work /home/ci
USER ci
WORKDIR /work
