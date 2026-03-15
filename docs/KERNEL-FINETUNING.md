# Kernel Fine-Tuning: MetaClaw RL Integration

> Exploration doc for continuous RL fine-tuning of 8gent's local models via [MetaClaw](https://github.com/aiming-lab/MetaClaw).

## Motivation

8gent currently routes to static model weights (Ollama local, OpenRouter cloud). Models never improve from our sessions. MetaClaw lets us close the loop: every coding session becomes training data, and GRPO continuously evolves a LoRA adapter on top of our base model.

## Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌──────────────┐
│  8gent TUI  │─────▶│  MetaClaw Proxy  │─────▶│    Ollama     │
│  (Bun/Ink)  │◀─────│  :30000          │◀─────│  :11434       │
└─────────────┘      └────────┬─────────┘      └──────────────┘
                              │
                     ┌────────▼─────────┐
                     │  Judge LLM (PRM) │  ← scores responses
                     │  gemini-2.5-flash│    asynchronously
                     └────────┬─────────┘
                              │
                     ┌────────▼─────────┐
                     │  GRPO Trainer    │  ← LoRA fine-tuning
                     │  (MinT backend)  │    during idle/sleep
                     └────────┬─────────┘
                              │
                     ┌────────▼─────────┐
                     │  Hot-swap LoRA   │  ← adapter merged
                     │  back to Ollama  │    without restart
                     └─────────────────┘
```

## Base Model Selection

| Model | Rationale | VRAM (LoRA) | Recommended |
|-------|-----------|-------------|-------------|
| `qwen3.5:latest` | TUI default, strongest coding benchmarks, already tested in autoresearch | ~18GB | **Primary** |
| `qwen2.5-coder:14b` | Purpose-built for code, 14B sweet spot for LoRA | ~12GB | **Secondary** |
| `devstral:latest` | Mistral code specialist, good benchmark diversity | ~14GB | Experimental |
| `qwen3:14b` | Strong reasoning, general fallback | ~12GB | Fallback |

**Start with `qwen2.5-coder:14b`** for initial RL runs (most VRAM-friendly, code-native), graduate to `qwen3.5:latest` once the pipeline is validated.

## MetaClaw Config for 8gent

See `config/metaclaw.yaml` for the ready-to-use configuration.

Key decisions:
- **Mode: `madmax`** — RL training deferred to idle/sleep so it never blocks active coding sessions
- **Judge: `gemini-2.5-flash:free`** via OpenRouter — we already have this configured, free, fast enough for async scoring
- **Backend: `mint`** — open-source, runs locally, no cloud dependency for training
- **LoRA rank: 32** — balanced capacity vs training speed
- **Skills dir** points to our benchmark learnings so MetaClaw can inject relevant context

## Integration Points

### 1. Provider Redirect (minimal change)

The Ollama client in `packages/eight/clients/ollama.ts` already accepts a `baseUrl` parameter. When MetaClaw is running, we redirect:

```typescript
// Before: direct to Ollama
const client = new OllamaClient(model, "http://localhost:11434")

// After: through MetaClaw proxy
const client = new OllamaClient(model, "http://localhost:30000")
```

MetaClaw's proxy is OpenAI-compatible, so no request format changes needed.

### 2. Config Toggle

Add to `.8gent/config.json`:

```json
{
  "metaclaw": {
    "enabled": false,
    "proxyUrl": "http://localhost:30000",
    "autoStart": false
  }
}
```

When `metaclaw.enabled`, the provider manager routes Ollama calls through the proxy.

### 3. Benchmark Validation Loop

Our existing autoresearch harness becomes the **RL validation set**:

```
After N training batches:
  1. Run autoresearch-loop against fine-tuned model
  2. Compare scores vs baseline (pre-training snapshot)
  3. If regression detected → rollback LoRA checkpoint
  4. If improvement → promote checkpoint, log to CHANGELOG
```

The `model-router.ts` experience system naturally tracks this — fine-tuned models that score higher get routed to first.

### 4. Judge Model Wiring

MetaClaw needs a PRM (Process Reward Model) to score responses. We use Gemini Flash via OpenRouter:

```yaml
rl:
  prm_url: https://openrouter.ai/api/v1
  prm_model: google/gemini-2.5-flash:free
  prm_api_key: ${OPENROUTER_API_KEY}
```

This keeps training costs at zero while getting competent judging.

## Training Data Sources

| Source | Signal Type | Volume |
|--------|------------|--------|
| Live coding sessions | Conversation traces | Every session |
| Autoresearch benchmark runs | Scored solutions | Batch after each run |
| Bug fix sessions | Error→fix pairs | High signal |
| Tool call sequences | Action planning | Pattern learning |

## Safety Rails

1. **Checkpoint before every LoRA swap** — always rollback-able
2. **Benchmark gate** — new weights must match or beat baseline on autoresearch suite
3. **MadMax scheduling** — training never happens during active sessions
4. **LoRA isolation** — base model weights never modified, only adapter layers
5. **A/B routing** — model-router can split traffic between base and fine-tuned to measure real impact

## Phase Plan

### Phase 1: Proxy Only (no training)
- Install MetaClaw in `skills_only` mode
- Route 8gent through proxy
- Validate no latency regression
- Collect conversation traces

### Phase 2: Judge + Scoring
- Enable PRM scoring via Gemini Flash
- Observe score distribution across sessions
- Tune PRM prompts for coding-agent relevance

### Phase 3: RL Training
- Enable GRPO with MinT backend
- Start with `qwen2.5-coder:14b` base
- Run autoresearch validation after each training window
- Track improvement curves

### Phase 4: Production Loop
- Graduate to `qwen3.5:latest` base
- Enable MadMax scheduling
- Wire benchmark regression gates
- Auto-log improvements to model-router experience

## Open Questions

- [ ] MinT backend GPU requirements — need to validate on consumer hardware (RTX 4090 target)
- [ ] LoRA adapter format compatibility between MinT output and Ollama's expected GGUF adapters
- [ ] Optimal PRM scoring criteria for coding agent tasks (execution success vs code quality vs tool use efficiency)
- [ ] How to handle multi-turn conversations — score final outcome or each turn?
- [ ] Interaction between MetaClaw's skill injection and 8gent's own system prompt mutations
