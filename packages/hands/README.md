# @8gent/hands

Thin Bun wrapper around the locally-installed `cua-driver` MCP binary.
Powers the 8gent Computer Mac app (`apps/8gent-computer/`).

## Status

v0.1.0. Real wrapper, NOT the fork yet.

- Shells out to `/usr/local/bin/cua-driver` v0.0.4 (CuaDriver.app).
- Plans natural-language requests into tool sequences via an OpenAI-compatible
  `/v1/chat/completions` endpoint (default: local Ollama).
- Falls back to a regex stub when no LLM is reachable so it still runs offline.
- The package will become the embedded `8gent-hands` fork later. See
  [#1746](https://github.com/8gi-foundation/8gent-code/issues/1746).

## Usage

```bash
# Default: local Ollama (qwen3:32b), stub fallback.
bun run packages/hands/run.ts "take a screenshot"

# Force stub mode (no network, no model).
HANDS_PLANNER=stub bun run packages/hands/run.ts "list apps"

# Point at a different OpenAI-compatible endpoint.
HANDS_LLM_BASE_URL=https://openrouter.ai/api/v1 \
HANDS_LLM_MODEL=meta-llama/llama-3.1-8b-instruct:free \
HANDS_LLM_API_KEY=sk-or-... \
  bun run packages/hands/run.ts "what apps are running"
```

stdout is a single `RunResult` JSON object. Wrapper / planner chatter goes to
stderr so the calling Swift app can decode stdout cleanly.

## Env

| Var                  | Default                             | Purpose |
|----------------------|-------------------------------------|---------|
| `HANDS_BIN`          | `/usr/local/bin/cua-driver`         | Path to the cua-driver binary. |
| `HANDS_PLANNER`      | unset (= LLM with stub fallback)    | Set to `stub` to force offline mode. |
| `HANDS_LLM_BASE_URL` | `http://localhost:11434/v1`         | OpenAI-compatible chat completions endpoint. |
| `HANDS_LLM_MODEL`    | `qwen3:32b`                         | Model name to send. |
| `HANDS_LLM_API_KEY`  | unset                               | Sent as `Authorization: Bearer ...` if set. |
| `HANDS_IMG_DIR`      | `/tmp`                              | Directory for screenshot PNGs. |

## Stub vocabulary

When the LLM is unreachable the stub recognises:

- `screenshot`, `take a screenshot`, `screen shot`, `capture screen`
- `list apps`, `list applications`, `list running apps`
- `list windows`
- `screen size`
- `cursor position`
- `check permissions`
- `click at <x> <y>` (optional `pid <n>`)

Anything else returns an empty plan and the run reports `ok: false`.

## Honest v0 limitations

- LLM planner picks wrong tools on ambiguous prompts.
- No NemoClaw policy gating yet (every step runs the moment it's planned).
- No streaming; the Swift app waits for the full subprocess to exit.
- No retry, no cancellation token. Fire-and-forget per step.
- macOS only. Hands deliberately does not abstract platforms in v0.

## Attribution plan

When the fork lands, the upstream `trycua/cua` MIT licence will be preserved
in `LICENSE-cua` and a `NOTICE` block added here. Today nothing has been
vendored, so no attribution is required.

## Non-goals

- Linux / Windows support.
- Generic browser automation (lives in `agent-browser`).
- Any work blocked on the Karen security review (#1748).
