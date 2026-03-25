# router-optimizer

**Status:** Quarantine - review before wiring into agent loop

**File:** `packages/providers/router-optimizer.ts`

---

## What it does

Adaptive model router. Given a prompt (or pre-built `TaskProfile`), it:

1. Classifies complexity (`trivial` -> `expert`) using heuristic signals (length, multi-step, math, tool count).
2. Classifies category (`chat`, `code-gen`, `debugging`, `tool-use`, etc.).
3. Scores all known model candidates against the profile using hard filters and a weighted scoring function.
4. Returns a `RouteDecision` with the best model, cost estimate, reasoning string, and a 3-deep fallback chain.
5. Records outcomes per model + category and applies exponential moving average to category scores.
6. Persists history as newline-delimited JSON at `~/.8gent/router-history.jsonl`.

---

## Core exports

```ts
class RouterOptimizer
  classify(prompt, opts) -> TaskProfile
  route(profile, availableProviders?) -> RouteDecision
  routePrompt(prompt, opts) -> RouteDecision       // classify + route in one call
  record(PerformanceRecord) -> void                 // track outcome
  getModelStats(provider, model) -> ModelStats | null
  getAllStats() -> ModelStats[]
  getSummary() -> { trackedModels, totalRequests, topModel, frugalMode, latencyWeight }
  reset() -> void

// Singleton helpers
getRouterOptimizer(config?) -> RouterOptimizer
resetRouterOptimizer() -> void
```

---

## Usage example

```ts
import { getRouterOptimizer } from "./packages/providers/router-optimizer.ts";

const router = getRouterOptimizer({ frugalMode: true });

const decision = router.routePrompt("Refactor this TypeScript class for clarity", {
  toolCount: 0,
  availableProviders: new Set(["ollama", "8gent"]),
});
console.log(decision.model, decision.reasoning);
// -> "qwen3.5:latest", "moderate code-review task, routed to local model (zero cost), ..."

router.record({
  provider: decision.provider,
  model: decision.model,
  category: "code-review",
  complexity: "moderate",
  latencyMs: 1240,
  success: true,
  tokenCount: 840,
});
```

---

## Scoring logic

Each candidate receives a score built from:

| Signal | Points | Notes |
|--------|--------|-------|
| Quality tier match | 0-50 | Hard floor per complexity level |
| Cost (lower = better) | 0-30 (x2 in frugal mode) | Relative to claude-3.5-sonnet baseline |
| Local model | 0-20 (x2 in frugal mode) | Zero network, zero cost |
| Category affinity | 0-15 | Per-category provider preference list |
| Historical success rate | 0-10 | Requires >= 3 samples |
| Historical category score | 0-10 | EMA, alpha=0.3 |
| Latency penalty | -0-10 | Scaled by `latencyWeight` config |
| Below min success rate | -30 | Deprioritizes flaky models |

Hard filters (score = -Infinity, excluded from routing):
- Quality tier below complexity floor
- Tool-use required but model lacks it
- Vision required but model lacks it
- Context window too small for estimated tokens
- Paid model when `freeOnly = true`

---

## Configuration

```ts
interface RouterOptimizerConfig {
  historyPath?: string;        // default: ~/.8gent/router-history.jsonl
  maxHistorySize?: number;     // default: 1000 records
  latencyWeight?: number;      // default: 0.3 (0=quality only, 1=speed only)
  minSuccessRate?: number;     // default: 0.6 - deprioritize below this
  frugalMode?: boolean;        // default: true - prefer free/local
}
```

---

## Integration checklist

Before wiring into `packages/eight/agent.ts`:

- [ ] Derive `availableProviders` from `ProviderManager.listEnabledProviders()` at call time - not hardcoded.
- [ ] Wrap `record()` call in agent's post-response hook, not inside the router itself.
- [ ] Test `freeOnly` path with no OpenRouter key available - should fall back to `ollama`.
- [ ] Test `expert` complexity routing - should never land on a free model unless absolutely necessary.
- [ ] Add `preferLocal: true` when Ollama is healthy (ping `localhost:11434/api/tags`).
- [ ] Confirm history file doesn't grow unbounded on long-running daemon sessions (maxHistorySize trims in-memory but appends to disk - add periodic rotation if needed).

---

## What this is NOT doing

- No live latency probing or health checks - caller must set `availableProviders`.
- No price fetching from OpenRouter API - costs are hardcoded catalog values.
- No fine-grained token counting - uses `prompt.length / 3.5` estimate.
- No model warm-up or preloading.
- No multi-agent orchestration (that lives in `packages/orchestration/`).
