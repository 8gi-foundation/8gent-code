# 8gent Model Proxy

An OpenAI-compatible localhost gateway over the 8gent adaptive router. Run one
binary, point any OpenAI-compatible client at `http://127.0.0.1:8787/v1`, and
every request is dispatched through the 8gent router
(`packages/providers` + `packages/eight/clients`) - keeping local-first routing,
the PII-egress gate, thinking-level resolution and model-not-found reroute
intact.

The proxy is a thin translation layer. It imports the router; it does not
duplicate any routing logic. Provider selection, failover and the PII gate all
live in `ProviderManager.chat()`.

## Why

Any tool that speaks the OpenAI API (SDKs, editors, agents, scripts) can now use
the 8gent router without embedding it. Your keys are the only keys in play, and
local providers (8gent, Ollama, LM Studio) are preferred by default - nothing
leaves the machine unless the active provider is a cloud one, and even then the
PII-egress gate anonymizes or fails closed.

## Quickstart (from source)

```bash
bun install                       # from the repo root
bun run apps/proxy/src/index.ts   # starts on http://127.0.0.1:8787
```

Point a client at it:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"eight-1.0-q3:14b","messages":[{"role":"user","content":"hello"}]}'
```

Or with the OpenAI Python SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
client.chat.completions.create(
    model="eight-1.0-q3:14b",
    messages=[{"role": "user", "content": "hello"}],
)
```

### Endpoints

| Method | Path                    | Purpose                                    |
| ------ | ----------------------- | ------------------------------------------ |
| POST   | `/v1/chat/completions`  | Chat completion (non-streaming and SSE).   |
| GET    | `/v1/models`            | Enabled providers' models, OpenAI-shaped.  |
| GET    | `/health`               | Liveness + the router's active selection.  |

### Flags

| Flag              | Env          | Default     |
| ----------------- | ------------ | ----------- |
| `-p, --port <n>`  | `PROXY_PORT` | `8787`      |
| `-H, --host <a>`  | `PROXY_HOST` | `127.0.0.1` |

Binding defaults to loopback. Pass `--host 0.0.0.0` only if you deliberately
want the proxy reachable on your LAN.

## Install (compiled binary)

The proxy compiles to a single self-contained binary per OS/arch with
`bun build --compile` - no runtime, no `node_modules` on the target machine.

```bash
bash apps/proxy/scripts/compile.sh            # all targets into apps/proxy/dist/
bash apps/proxy/scripts/compile.sh darwin-arm64   # or one target
```

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win-x64`.

### macOS / Linux

Copy the matching binary onto your `PATH`:

```bash
install -m 0755 apps/proxy/dist/8gent-proxy-darwin-arm64 /usr/local/bin/8gent-proxy
8gent-proxy
```

### Linux packages + background service

`.deb` / `.rpm` are built with [nfpm](https://nfpm.goreleaser.com):

```bash
cd apps/proxy/packaging/linux
ARCH=amd64 BIN=../../dist/8gent-proxy-linux-x64   nfpm package -f nfpm.yaml -p deb
ARCH=amd64 BIN=../../dist/8gent-proxy-linux-x64   nfpm package -f nfpm.yaml -p rpm
```

Run it in the background as a **user** service (never root):

```bash
systemctl --user enable --now 8gent-proxy
systemctl --user status 8gent-proxy
```

### Windows installer + service

The [NSIS](https://nsis.sourceforge.io) installer wraps the `win-x64` binary and
can optionally register a background Windows service via
[WinSW](https://github.com/winsw/winsw):

```bat
makensis -DPROXY_BIN=..\..\dist\8gent-proxy-win-x64.exe 8gent-proxy.nsi
8gent-proxy-setup.exe            :: plain install
8gent-proxy-setup.exe /SERVICE   :: install + register the background service
```

## Release automation

`.github/workflows/release-proxy.yml` builds every OS artifact and (when signing
secrets are present) signs them. It is **committed but gated on GitHub Actions
billing** for the org - see the header comment in that file. Until billing is
restored, run the per-OS steps above locally on each platform.

## Signing

Producing **signed, notarized** installers requires certificates and accounts
that are not in this repo. Signing is wired as opt-in via secrets and skips
cleanly when absent. See [SIGNING.md](./SIGNING.md) for exactly what to procure.
