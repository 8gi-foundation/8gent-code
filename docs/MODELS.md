# Models

Canonical list of models the 8gent Code agent can route to, by tier and channel.
The runtime registry is at `packages/eight/registry.ts`. The failover chains are
at `packages/providers/failover.ts`.

## Channels

Each daemon session carries a `channel` field. The two relevant routes:

- `text`: the legacy text-channel chain, anchored on the local 8gent default.
- `computer`: the 8gent Computer surface (voice-first ambient agent).

## Computer-channel chain

```
1. apfel (chat tier, on-device)
2. Qwen 3.6-27B (vision/tool, DEFAULT)
3. DeepSeek V4-Flash (heavy cloud)
4. OpenRouter :free (last resort)
```

### apfel - chat tier

- Repo: https://github.com/Arthur-Ficial/apfel (MIT)
- Apple Silicon, macOS 26 Tahoe+
- Exposes Apple Foundation at a Chat Completions API endpoint
- **No vision support.** Vision-bearing prompts are rejected up-front; the
  failover chain catches the rejection and falls through to the next tier.
- Default base URL: `http://localhost:11434/v1`
- **Port collision with Ollama:** Ollama also defaults to 11434. To run both,
  start apfel on a different port and override the env var:

  ```bash
  apfel serve --port 11500
  export APFEL_BASE_URL=http://localhost:11500/v1
  # Ollama keeps OLLAMA_BASE_URL=http://localhost:11434
  ```

  Smoke tests assume one of the two is running. Do not start both at once
  on 11434.

Env: `APFEL_BASE_URL` (optional, default `http://localhost:11434/v1`)

### Qwen 3.6-27B - vision/tool tier (default brain)

- Apache 2.0, dense vision-language model, 27B params
- 125K context window
- Capabilities: text, vision, tool-calling, streaming
- Reachable via Ollama 0.6.2+ (`ollama pull qwen3.6:27b`) or LM Studio 0.4.12+
- Footprint: ~21 GB at Q4_K_M; needs 24 GB VRAM or 32 GB unified memory
- Registered as the default for the `computer` channel

Env: `OLLAMA_URL` or `LM_STUDIO_HOST` (whichever backend you use); optional
`QWEN_BACKEND=ollama|lmstudio` for the smoke test.

### DeepSeek V4-Flash - heavy cloud fallback

- MIT, 284B/13B MoE, 1M context
- Direct API at `https://api.deepseek.com/v1` (Chat Completions API style)
- Capabilities: text, tool-calling, streaming. No vision.
- V4-Pro (1.6T/49B) is flagged-only via `DEEPSEEK_USE_PRO=1`

Env: `DEEPSEEK_API_KEY` (required), `DEEPSEEK_USE_PRO` (optional, set `1` for Pro)

The client and smoke test never log or echo the key. Errors strip it
defensively.

### OpenRouter :free - last resort

The free-tier OpenRouter chain at the bottom of the failover. Used only when
every other tier is down.

Env: `OPENROUTER_API_KEY`

## Text-channel chain (legacy, unchanged)

The text channel keeps its existing chain anchored on `eight-1.0-q3:14b` and
the local `qwen3.5:latest`. No regressions: the failover resolver defaults to
the `text` channel when no channel is passed, so existing callers behave as
before.

## Smoke tests

```bash
bun run packages/eight/scripts/smoke-apfel.ts           # chat tier
bun run packages/eight/scripts/smoke-apfel.ts --test-vision  # rejection path
bun run packages/eight/scripts/smoke-qwen36.ts          # vision/tool tier
bun run packages/eight/scripts/smoke-deepseek-v4.ts     # heavy cloud
bun run packages/eight/scripts/smoke-failover-chain.ts  # resolver, no live calls
bun run packages/eight/scripts/computer-use-suite.ts    # Phase 3 cua loop suite (issue #1867)
```

## Vision prompt template

Computer-use prompts go through `packages/eight/prompts/computer-use-vision.ts`.
The template is tuned for the Qwen 3.6-27B vision/tool tier (default). The same
text scaffolding works on the heavy cloud tier (DeepSeek V4-Flash, no vision):
the runner calls `stripVisionParts()` to drop the image part and the model sees
the perception summary as plain text plus a one-line "vision disabled" hint.

What changes when the template is pointed at a non-Qwen vision model:
- Image budget: tile arithmetic in `perception/screenshot.ts` assumes
  512x512 tiles. Other vision models that use 384x384 or 768x768 tiles
  need a tweak to `estimateScreenshotCost()`.
- Tool-call format: the template assumes the chat-completions tool-call
  shape used by Qwen 3.6 + DeepSeek V4. Models that emit tool calls in a
  different shape need an adapter inside the LLM client, not the prompt.
- Termination: the template requires the model to call `goal_complete` /
  `goal_failed`. Models without reliable tool-call termination should be
  wrapped with a regex parser in the loop (out of scope for v0).

## Declared providers (Hugging Face Inference Providers or any OpenAI-compatible endpoint)

A provider name in `~/.8gent/providers.json` that is not compiled in is a
declaration. It needs a `baseUrl` and nothing else (source:
`packages/providers/declared.ts`). The entry is ignored with a warning if
`baseUrl` is missing or is not http(s).

Hugging Face Inference Providers exposes an OpenAI-compatible router at
`https://router.huggingface.co/v1`, chat endpoint
`https://router.huggingface.co/v1/chat/completions`, authenticated with a
Hugging Face token as a bearer token (confirmed against
huggingface.co/docs/inference-providers, 2026-10-10). Hugging Face can change
this, so re-check that page if the connection fails.

```json
{
  "activeProvider": "huggingface",
  "activeModel": "openai/gpt-oss-120b",
  "providers": {
    "huggingface": {
      "displayName": "Hugging Face",
      "baseUrl": "https://router.huggingface.co/v1",
      "compat": "openai",
      "apiKeyEnv": "HF_TOKEN",
      "defaultModel": "openai/gpt-oss-120b"
    }
  }
}
```

Then put the token in the shell that starts 8gent, and start 8gent from that
same shell. Read it without echo so it never lands in your shell history or on
screen:

```bash
read -rs HF_TOKEN && export HF_TOKEN
```

Do not type `export HF_TOKEN=hf_...` on the command line (it is saved in
history), do not add it to a dotfile that is committed or synced, and use a
fine-grained token with only the Inference Providers permission so a leak can
be revoked cheaply. If the variable is not set, the request
fails with "No API key for Hugging Face. Set HF_TOKEN", which means the shell,
not the file, is what to fix. Name a model as in the example rather than relying
on discovery for a first run.
Fields, all optional except `baseUrl`:

| Field | Default | Meaning |
|-------|---------|---------|
| `compat` | `"openai"` | Wire shape: `"openai"` (`{baseUrl}/chat/completions`, `{baseUrl}/models`), `"ollama"`, or `"anthropic"` |
| `apiKeyEnv` | `""` (keyless) | Name of the environment variable holding the key |
| `apiKey` | none | A literal key stored in the file. Avoid it, see below |
| `defaultModel` / `models` | empty | Model ids; when empty, discovery asks the endpoint (`GET {baseUrl}/models`, 5 s timeout) |
| `supportsTools`, `supportsStreaming` | `true` | Set `false` to turn off |
| `supportsVision` | `false` | Opt-in |
| `supportedThinkingLevels` | `[]` | Unrecognised levels are dropped |
| `enabled` | `true` | Writing the entry is the opt-in |

Use `apiKeyEnv`, not `apiKey`. `providers.json` is a plain file that gets
copied, synced and pasted into bug reports, and a literal key in it travels
with it. If a literal key does end up in the file (for example from a settings
screen that writes one), run `chmod 600 ~/.8gent/providers.json`, never commit
the file, never paste it or screenshot it, and rotate the token if it ever
leaves your machine. An environment variable keeps the secret out of the file, and an
empty `apiKeyEnv` is how a declaration says "no key needed", so a keyless local
endpoint and a keyed cloud one are written the same way.

Things to know before you rely on it:

- Cloud is opt-in, and it is a real data egress. Once this provider is active,
  your prompts, file contents, tool output and the code context in them leave
  your machine for Hugging Face and whichever downstream provider it routes to,
  which are third parties under their own retention terms. 8gent's PII
  anonymization gate is the only filter on that path. It is pattern based, so
  it can miss personal data, and it does not scrub secrets, proprietary code or
  confidential business content. Do not use this provider on a repo or session
  that holds personal data, children's data, client confidential material or
  credentials. Keep those on a local provider.
- Tool calling depends on the model and provider chosen. `supportsTools`
  defaults to `true`, but that is only 8gent's assumption; some models and
  providers behind the router do not implement tool calls well or at all.
  Test with a small task first.
- Model ids take Hugging Face's own suffixes (`:fastest`, `:cheapest`,
  `:preferred`, or a provider name). The router picks the downstream
  provider, so behaviour can differ between runs.
- A secure key entry screen, so you do not have to hand-edit a file or
  export variables, is tracked in #3848.

## Adding a new model

1. Add a `ModelEntry` to `MODELS` in `packages/eight/registry.ts`.
2. If it belongs in a chain, edit `defaultComputerChains()` or
   `defaultTextChains()` in `packages/providers/failover.ts`.
3. If it needs a new client, add it under `packages/eight/clients/` matching
   the existing Chat Completions API shape, then wire it in
   `packages/eight/clients/index.ts` (`createClient` + `runtimeForProvider`).
4. Add a smoke test under `packages/eight/scripts/smoke-<model>.ts`.
5. Update this file.
