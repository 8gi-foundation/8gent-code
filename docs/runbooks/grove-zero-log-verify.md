# Grove Zero-Log Invariant — Verify on Your Own Node

> Issue #1569 / parent #1559

## What this is

Grove's core privacy guarantee: **peer nodes MUST NOT persist activations, prompts, or responses to disk**. Streams live in process memory only. No file writes. No DB writes. No log lines containing prompt or activation bytes.

If this invariant ever broke, anyone with shell access to a peer could reconstruct what other peers had asked it to compute. That defeats the entire trust model.

## How it's enforced today

Three layers:

1. **Transport code review.** Files in `packages/orchestration/vessel-mesh.ts` (and any future `packages/grove/transport/**`) cannot import `fs` / `node:fs` / `fs/promises` and cannot call `writeFile*`, `appendFile*`, `createWriteStream`, or any DB insert/put. The CI step `Grove zero-log invariant` greps for these on every PR.
2. **Mesh handler.** `VesselMesh.handleIncomingMessage` and `mesh.onTask` route incoming task payloads straight into `pool.chat()` and back out as `result` frames — no intermediate persistence.
3. **Daemon log subscriber.** `setupLogging()` in `packages/daemon/index.ts` writes event metadata (event name, sessionId, timestamps) to `~/.8gent/daemon.log`. It does NOT log prompt text or response text — those are stripped before the bus emits.

## Verify on your own node (5 minutes)

You need: a running daemon with `GROVE_ENABLED=1`, `ripgrep` (`brew install ripgrep`), and 5 minutes.

### 1. Pick a marker

Choose a string that won't appear naturally in your logs:

```bash
MARKER="ZEROLOG-$(uuidgen)"
echo "$MARKER"
```

### 2. Send a task containing the marker

From any machine that can reach your peer:

```bash
bun run scripts/grove-mesh-test.ts \
  --peer ws://your-peer:18789 \
  --prompt "Say back exactly: $MARKER and nothing else"
```

(Or use whatever peer-test script you have. The point is the marker must travel through the mesh and into a generation.)

### 3. Scan the peer's filesystem for the marker

On the peer:

```bash
# Daemon log
rg -F "$MARKER" ~/.8gent/daemon.log && echo "FAIL: marker in daemon log" || echo "PASS: daemon log clean"

# Data dir (catches any new file the daemon might write)
rg -F "$MARKER" ~/.8gent/ && echo "FAIL: marker in data dir" || echo "PASS: data dir clean"

# /tmp (catches any tempfile)
rg -F "$MARKER" /tmp/ 2>/dev/null && echo "FAIL: marker in /tmp" || echo "PASS: /tmp clean"

# Process memory (sanity-check only — should find it if the daemon is mid-stream)
ps -ef | grep "8gent" | grep -v grep
# If you want to be thorough: dump the daemon process and grep the dump
```

### 4. Read the result

All three filesystem scans should return **PASS**. If any returns **FAIL**, the invariant is broken and you should:

1. Stop the daemon (`pkill -f 8gent` or your equivalent).
2. Open an issue tagged `security` / `grove` with the file path that contained the marker.
3. Do not redeploy until the leak source is fixed.

## What this verification proves

- The marker bytes travelled through the mesh and were generated against
- The peer did not persist the marker bytes anywhere on its filesystem
- Therefore the mesh transport on this peer is currently honouring zero-log

## What this does NOT prove

- That the *upstream model provider* (OpenRouter, Ollama, etc.) is also zero-log. That's their privacy policy, not yours.
- That memory-only streams can't be intercepted by another process with `ptrace`/`procmem` rights. Out of scope for the transport invariant — that's host hardening.
- That a future PR won't introduce a write. The CI grep guard catches the obvious cases; the audit test (still TODO, see #1569 deliverable 2) catches the subtle ones.

## Related

- Constitution: Lotus-Class Compute (Article 11)
- Parent issue: #1559
- Spike deck: 8gi.org/internal/decks/lotus-spike (admin only)
- Spike code: `packages/orchestration/vessel-mesh.ts`, `packages/daemon/gateway.ts`
