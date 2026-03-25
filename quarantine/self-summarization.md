# Self-Summarization - Cursor's Approach vs Ours

## What Cursor Does

Cursor Composer 2's key innovation is **trained self-summarization**. During long coding sessions, the model compresses its own conversation context from 100k+ tokens down to ~1k tokens. The critical difference from naive summarization: they train the compression quality through RL.

### Their Pipeline

1. Model generates until hitting a token-length trigger
2. A synthetic query asks the model to summarize current context
3. Model gets scratch space to think about the best summary
4. Model outputs a ~1k token condensed context
5. Loop continues with condensed context replacing original messages

### Why It Works

The task completion reward propagates back to the summary tokens. If a summary drops a critical file path and the task fails, that summary gets penalized. If a summary preserves the right context and the task succeeds, it gets reinforced. The model learns WHAT matters through outcomes, not heuristics.

**Result:** 50% fewer compaction errors vs prompted summarization. In one Terminal-Bench challenge, Composer 2 self-summarized 100k+ tokens to ~1k over 170 turns while maintaining task coherence.

---

## What We Do (packages/kernel/self-summarizer.ts)

We start with **prompted summarization via Ollama** - the non-trained version. This is the pragmatic first step because:

1. We don't have the compute for RL training on summarization quality (yet)
2. Prompted summarization still provides 5-10x compression
3. We track compression quality metrics, building a dataset for future GRPO training

### Our Pipeline

1. Agent loop monitors context token count
2. When context hits 80% of the model's window, `shouldSummarize()` triggers
3. `summarize()` sends conversation to Ollama with a structured extraction prompt
4. Ollama returns a ~1k token structured summary (files, decisions, errors, state, next steps)
5. Quality tracker compares original vs summary - what file paths survived? What errors survived? What decisions survived?
6. Metrics are persisted to `.8gent/kernel/summarizer/quality-metrics.jsonl`
7. Summary replaces original messages in the conversation

### Quality Tracking

This is the bridge to trained summarization. Every compression produces a `CompressionQuality` record:

- **filePathsKept/Lost** - Did the summary preserve the file paths being worked on?
- **errorsKept/Lost** - Did the summary preserve error messages?
- **decisionsKept** - Did the summary preserve reasoning ("chose X because Y")?
- **retentionScore** - Weighted 0-1 score (50% paths, 30% errors, 20% decisions)

These metrics serve two purposes:
1. **Immediate:** Flag bad summaries (retentionScore < 0.5) before they corrupt context
2. **Future:** Feed (summary, task_outcome) pairs into GRPO training, closing the gap with Cursor's trained approach

---

## Gap Analysis

| Aspect | Cursor | Us (Now) | Us (Future) |
|--------|--------|----------|-------------|
| **Compression quality** | RL-trained, 50% fewer errors | Prompted, heuristic extraction | GRPO-trained on quality-metrics.jsonl |
| **What to keep** | Learned through task outcomes | Hardcoded in prompt (files, errors, decisions) | Learned through GRPO reward signal |
| **Target size** | ~1k tokens | ~1k tokens | ~1k tokens |
| **Model** | Kimi K2.5 (1T MoE, 32B active) | Qwen 3.5 (local, free) | Qwen + LoRA trained on our data |
| **Compute cost** | Massive RL training budget | Zero extra training cost | Incremental GRPO batches |
| **Filesystem safety** | None (context only) | Checkpoint-restore via git stash | Hybrid: summary + checkpoint |

### The Hybrid Advantage

Cursor does context compression only. We combine it with checkpoint-restore (`packages/validation/`). If a summary drops something critical and the task fails, we can revert to a git stash checkpoint and retry. Cursor can't do this - once their summary loses information, it's gone.

**Our path:** Prompted summarization now, collect quality data, train with GRPO later. The checkpoint-restore safety net means we can ship prompted summarization today without the risk of catastrophic information loss.

---

## Integration Path

### Phase 1 (This PR)
- `SelfSummarizer` class with Ollama-based compression
- Quality tracking and persistence
- No integration with agent loop yet - quarantined for review

### Phase 2 (Next)
- Wire into `packages/eight/agent.ts` - trigger when context hits threshold
- Combine with checkpoint-restore: summarize context AND create git stash
- A/B test: sessions with summarization vs without

### Phase 3 (Later)
- Feed quality-metrics.jsonl into GRPO training pipeline
- Add summarization turns to training trajectories in `packages/kernel/training.ts`
- Propagate task outcome reward to summary quality
- Close the gap with Cursor's trained approach
