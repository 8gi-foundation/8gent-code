#!/usr/bin/env bash
# 8gent CLI - The Infinite Gentleman
# Runs the full TUI experience
exec bun run /home/operator/8gent-code/apps/tui/src/index.tsx "$@"
