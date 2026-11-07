# Deployment

8gent Code describes the daemon protocol and how to self-host the daemon. It does not describe any particular hosted deployment.

## Self-hosting the daemon

The daemon is `packages/daemon/index.ts`. It speaks the WebSocket protocol in `docs/specs/DAEMON-PROTOCOL.md`. You can run it on any host you control, in a container or directly.

Run it locally (no Docker needed):

```bash
bun run packages/daemon/index.ts
```

Test the WebSocket protocol:

```bash
bun run scripts/test-ws-client.ts
```

Test against a daemon you host elsewhere:

```bash
DAEMON_URL=wss://your-host.example bun run scripts/test-ws-client.ts
```

## Container notes

- Runtime: Bun.
- Port: the WebSocket gateway listens on `18789`.
- State: mount a persistent volume at the data directory (default `~/.8gent/`), or set `EIGHT_DATA_DIR`.
- Keep deployment secrets and infrastructure config out of this repository.

## Hosted service

For the hosted service, see the platform repos (control plane, model proxy).
