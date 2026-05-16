# gbrain — knowledge brain via MCP

Optional integration. Use gbrain alongside 8gent-code when you want a dedicated long-term knowledge brain over your own content (notes, meetings, emails, transcripts, papers). 8gent-code's built-in memory layer continues to handle operational state (tool traces, working memory, procedural patterns, contradictions). The two systems cover different domains and do not need to be synced.

- gbrain: https://github.com/garrytan/gbrain (MIT)
- Built by Garry Tan, runs his own OpenClaw and Hermes deployments.
- We integrate via MCP. No code in this repo depends on gbrain. No vendored source. You install it independently.

## When to use it

Reach for gbrain when you want to query *your content*, not *your agent's state*:

- "What did I think about X last quarter?" (notes, journals)
- "Who works at Acme AI?" (people/companies KG built from emails or tweets)
- "Summarise everything I read about retrieval evals this month."

For agent operational queries (`what did the last test run say`, `what file did I edit last`) keep using 8gent-code's built-in memory tools.

## Install

One-time, ~30 minutes. Runs entirely on your machine.

```bash
git clone https://github.com/garrytan/gbrain.git ~/src/gbrain
cd ~/src/gbrain && bun install && bun link
gbrain init                       # picks a search mode + writes ~/.gbrain/config.json
gbrain import ~/notes/            # index your markdown
gbrain query "test the brain"     # confirm retrieval works
```

`gbrain init` asks once which search mode to use:

| Mode | Token budget per query | When to pick it |
|---|---|---|
| `conservative` | ~4K | Default for Haiku-tier downstream models |
| `balanced` | ~10K | Default for Sonnet-tier downstream models |
| `tokenmax` | ~20K | Default for Opus-tier downstream models |

The mode is the dose knob. Auto-suggests based on the model you configure.

### Embedding provider

OpenAI is the default. For fully local, point it at Ollama or llama.cpp before `gbrain init`:

```bash
gbrain providers list             # see all 14 supported providers
# pick one with env vars you already have set
```

## Wire it into 8gent-code via MCP

8gent-code already speaks MCP. gbrain ships an MCP server. Adding gbrain is a one-line MCP config entry.

Edit your MCP config (typically `~/.config/claude/mcp.json` or the equivalent for whatever MCP-aware host you run 8gent-code under):

```jsonc
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
```

That is the entire integration. Restart your host. Your agent now has tools like `gbrain_query` and `gbrain_search` available alongside the built-in 8gent toolset.

### Remote brain (optional)

If you want one shared brain across multiple machines (e.g. a host on your Hetzner box ingesting overnight, and a laptop client querying it), gbrain supports a thin-client topology. Set up the host with `gbrain init`, register the client, and point your local MCP at the remote URL:

```jsonc
{
  "mcpServers": {
    "gbrain": {
      "type": "url",
      "url": "https://your-brain-host:3001/mcp",
      "headers": { "Authorization": "Bearer ${GBRAIN_REMOTE_CLIENT_SECRET}" }
    }
  }
}
```

See gbrain's `docs/architecture/topologies.md` for the full split-engine setup.

## What 8gent-code does not do

- No adapter code in `packages/memory/`. The bridge is MCP, not a TypeScript import.
- No sync between 8gent-code's SQLite memory and gbrain's store. Different domains.
- No bundled dependency on gbrain. Install it (or don't) per machine.

## Pattern imports tracked separately

Two patterns from gbrain are worth porting into our own memory layer regardless of whether you adopt gbrain itself. Both are clean-room imports against our own types, tracked in their own issues:

- Embedding-provider registry expansion (today we have Ollama + Null; gbrain has 14 providers).
- Retrieval-quality eval harness (LongMemEval-style scoring of P@5 / R@5 / latency for the local brain).

## Why we did not vendor it

- Different problem. gbrain is a knowledge brain. 8gent-code's `packages/memory/` is an operational brain with KG, multi-scope storage, procedural memory, contradictions, and traces. The functional overlap on KG + dedup + consolidation is real but their strengths are different.
- MCP is the right boundary. Both projects converge on it. Wiring through MCP keeps us free to swap, remove, or replace gbrain without surgery.
- Licence is fine (MIT into Apache 2.0), but the smaller surface area is more important than the legal headroom.
