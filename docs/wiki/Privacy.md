# Privacy

What stays on your machine, and what does not. Rules the project holds itself to: [principles gate](../security/principles-gate.md) and [PRINCIPLES](../PRINCIPLES.md). Path-by-path audit: [off-device data](../security/off-device-data.md).

## Model calls

- Local providers (`8gent`, `ollama`, `lmstudio`, `llama-server`, `apple-foundation`, and `apfel` on loopback) run on your machine. See [Providers and Models](Providers-and-Models).
- A hosted provider receives your prompts, tool results and images only when you have set its key. Each is `enabled: false` in `packages/providers/index.ts` until then.
- Failover drops hosted providers unless `EIGHT_ALLOW_HOSTED=1` (`packages/providers/failover.ts`).
- Under `routing.policy` `local-only`, non-GET/HEAD requests to non-local hosts are refused. Details and gaps: [routing policy](../ROUTING-POLICY.md).

## The /privacy command

`/privacy` (handled in `apps/tui/src/app.tsx`, report built in `packages/providers/locality.ts`) reads the ledger `~/.8gent/locality.jsonl` and shows how much of today's and this session's model traffic stayed local, each cloud model call with provider and size, and the active policy. The ledger holds time, provider, local or cloud, token counts and bytes sent, never prompt or reply text.

It covers model calls only. It does not report web search or web fetch requests.

## Web requests go to the web

- **`web_search`:** sends your search words to DuckDuckGo (`https://html.duckduckgo.com/html/`, `packages/tools/browser/web-search.ts`). If you set `EIGHT_SEARCH_URL` in your shell, searches go to that endpoint instead and never fall back to DuckDuckGo. A value in a `.env` file is ignored. See [search endpoint](../guides/search-endpoint.md).
- **`web_fetch`:** requests the URL it is given (`packages/tools/browser/fetch-page.ts`), so that site sees the request and your IP address.
- `web_search` is in the default tool set and the auto-allowed read-only set, so the model can call it without asking you ([off-device data](../security/off-device-data.md)).
- Each search appends its destination origin, never the query, to `~/.8gent/search-origins.jsonl`.
- The routing policy does not stop GET requests, so a query string can carry prompt text off the machine even under `local-only`.

## Other opt-in or typed-command paths

Cloud voice transcription (needs `OPENAI_API_KEY` and cloud mode; the default is local whisper.cpp), chat bridges, GitHub, and a few others each need a token or a typed command. The list is in [off-device data](../security/off-device-data.md).

## Telemetry

`packages/telemetry` stamps LLM, vessel and storage operations with a tenant id and writes one JSON line per event to stdout by default (`packages/telemetry/emitter.ts`). The package contains no network code. Shipping off-box happens only if you run the Vector config in `packages/telemetry/vector.toml`, which sends to a Loki endpoint (`LOKI_ENDPOINT`). I found no on/off setting for the stdout emission. The daemon also mirrors LLM events to `~/.8gent/flow/telemetry.jsonl`, a local file (`packages/daemon/index.ts`).

## Where data is stored

- Memory: SQLite `memory.db` in the global data dir (`~/.8gent`, or `EIGHT_DATA_DIR`) and a per-project `memory.db`; v1 files `~/.8gent/memory/global.jsonl` and `project.jsonl` (`packages/memory/index.ts`, `packages/memory/project-state.ts`). With in-repo project state enabled, the project store is `<repo>/.8gent/memory`.
- API keys: `~/.8gent/keys.env`.
- Locality ledger: `~/.8gent/locality.jsonl` (mode 0600).
- Declared providers: `~/.8gent/providers.json`.
