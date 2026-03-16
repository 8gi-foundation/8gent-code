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

## Implementation: `packages/kernel/`

All 4 phases are implemented in the `@8gent/kernel` package. The package provides a single entry point for the agent loop:

```typescript
import { KernelManager } from "@8gent/kernel";

// Initialize from .8gent/config.json
const kernel = KernelManager.fromProjectConfig();
await kernel.start();

// After each agent response:
const score = await kernel.processTurn(sessionId, turnIndex, model, prompt, response);

// Check health:
const health = kernel.getHealth(); // { healthy, trend, message }

// Get active model (base or fine-tuned):
const model = kernel.getActiveModel();

// Force training outside schedule:
await kernel.forceTraining();

// Shutdown:
await kernel.stop();
```

### Package Structure

| File | Phase | Purpose |
|------|-------|---------|
| `proxy.ts` | 1 | MetaClaw proxy lifecycle — start/stop, health checks, latency overhead monitoring |
| `judge.ts` | 2 | PRM scoring via Gemini Flash — async scoring, score distributions, daily trends |
| `training.ts` | 3 | GRPO batch collection — score filtering, checkpoint validation gate, auto-rollback |
| `loop.ts` | 4 | Production loop — MadMax scheduling, auto-promotion, health monitoring |
| `manager.ts` | All | Unified entry point, reads `.8gent/config.json`, safe no-op when disabled |
| `index.ts` | — | Barrel exports |

### Key APIs

**MetaClawProxy** (Phase 1):
- `start()` / `stop()` — lifecycle
- `measureLatency()` — compare direct vs proxied request times
- `isLatencyAcceptable()` — check overhead against threshold

**JudgeScorer** (Phase 2):
- `score(sessionId, turn, model, prompt, response)` — score a single turn
- `scoreBatch(items)` — fire-and-forget batch scoring
- `getScoreTrend(days)` — daily average trend
- `getDistribution()` — per-model stats

**TrainingOrchestrator** (Phase 3):
- `addSample(scoreRecord)` — buffer a scored response, auto-triggers training when batch full
- `train()` — manually trigger GRPO run
- `getCheckpoints()` — all checkpoints with status (promoted/rolled_back/training)
- `setBaseline(scores)` — save baseline for regression comparison

**ProductionLoop** (Phase 4):
- `processTurn(...)` — score + buffer + schedule (the one-liner for the agent loop)
- `getActiveModel()` — returns fine-tuned tag if promoted, base otherwise
- `getHealthStatus()` — improving/stable/declining trend with alert
- `forceTraining()` — bypass MadMax schedule

## Phase Plan

### Phase 1: Proxy Only (no training) — **IMPLEMENTED**
- ✅ Start/stop MetaClaw proxy process
- ✅ Health checks with configurable timeout
- ✅ Latency overhead monitoring (direct vs proxied)
- ✅ Configurable latency threshold with alerting
- ✅ Conversation trace collection via proxy passthrough

### Phase 2: Judge + Scoring — **IMPLEMENTED**
- ✅ PRM scoring via Gemini Flash (free via OpenRouter)
- ✅ 4-criteria scoring: execution success, code quality, tool efficiency, directness
- ✅ Score distribution tracking (per-model, per-day)
- ✅ Score trend analysis (7-day rolling window)
- ✅ Batch scoring for async processing
- ✅ Score history persistence (`.8gent/kernel/score-history.json`)

### Phase 3: RL Training — **IMPLEMENTED**
- ✅ GRPO batch collection with score-range filtering (skip trivial and perfect)
- ✅ Automatic training trigger when batch is full
- ✅ Checkpoint creation and lifecycle tracking
- ✅ Benchmark validation gate via autoresearch suite
- ✅ Auto-rollback on regression
- ✅ Training state persistence (`.8gent/kernel/training/state.json`)

### Phase 4: Production Loop — **IMPLEMENTED**
- ✅ MadMax scheduling (sleep window 23:00–07:00, idle threshold 30min)
- ✅ Auto-promotion of improved checkpoints into model-router experience DB
- ✅ Health monitoring with score trend alerts
- ✅ Graceful degradation when components unavailable
- ✅ `KernelManager` unified entry point with project config loading

## Open Questions

- [ ] MinT backend GPU requirements — need to validate on consumer hardware (RTX 4090 target)
- [ ] LoRA adapter format compatibility between MinT output and Ollama's expected GGUF adapters
- [x] Optimal PRM scoring criteria — implemented as 4-axis: execution success (40%), code quality (20%), tool efficiency (20%), directness (20%)
- [x] Multi-turn conversations — scoring each turn independently, overall tracked per-session via score history
- [ ] Interaction between MetaClaw's skill injection and 8gent's own system prompt mutations
