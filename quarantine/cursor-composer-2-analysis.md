# Cursor Composer 2 - Competitive Analysis

Released: March 19, 2026
Pricing: $0.50/M input, $2.50/M output tokens

---

## Executive Summary

Cursor shipped Composer 2, a frontier-level agentic coding model built on top of Moonshot AI's open-source Kimi K2.5 base model. They applied continued pretraining on code-specific data followed by reinforcement learning optimized for long-horizon coding tasks. The key technical innovation is "self-summarization" - a trained context compression technique that lets the model work effectively on tasks spanning 100k+ tokens of context.

Composer 2 beats Claude Opus 4.6 on Terminal-Bench 2.0 (61.7 vs 58.0) and scores 73.7 on SWE-bench Multilingual. GPT-5.4 still leads at 75.1 on Terminal-Bench.

---

## Architecture

### Base Model: Kimi K2.5

- **Type:** Mixture-of-Experts (MoE)
- **Total parameters:** 1 trillion
- **Active parameters per token:** ~32 billion
- **Expert count:** 384 experts, 8 active per token + 1 shared expert (always on)
- **Context window:** 200,000 tokens
- **Source:** Moonshot AI (open-source, Chinese lab)

The MoE architecture gives Composer 2 a massive knowledge store (1T params) with efficient inference (only 32B active). Cursor chose Kimi K2.5 specifically because the 6x active parameter advantage over smaller models was deemed essential for handling the "context explosion" during complex multi-step autonomous coding.

### Training Pipeline

1. **Continued Pretraining** - Fed the base Kimi K2.5 large volumes of source code, software engineering docs, commit histories, bug reports, and programming-related text. Same next-token-prediction objective but narrowed to code domain.

2. **Reinforcement Learning** - High-compute RL on long-horizon coding trajectories. Optimized for multi-file edits, terminal operations, and tool use within the Cursor IDE.

3. **Self-Summarization Training** (key innovation - see below)

---

## Self-Summarization: The Key Innovation

This is the most important technical contribution and directly relevant to our checkpoint-restore approach.

### How It Works

1. Model generates from a prompt until hitting a fixed token-length trigger
2. A synthetic query asks the model to summarize the current context
3. Model gets scratch space to think about the best summary
4. Model generates a condensed context (~1,000 tokens, down from 5,000+ with traditional summarization)
5. Loop continues with the condensed context

### Training Signal

- The final task reward applies to ALL tokens in the chain, including summaries
- Good summaries that preserve critical info and lead to successful task completion get reinforced
- Bad summaries that drop critical info and lead to failure get penalized
- This means the model learns WHAT to keep and what to discard through RL, not just prompted heuristics

### Results

- Reduces compaction errors by 50% vs traditional prompted summarization
- Summaries average ~1,000 tokens vs 5,000+ from prompted approaches
- In a Terminal-Bench 2.0 challenge, an early Composer checkpoint solved a problem over 170 turns, self-summarizing 100k+ tokens down to ~1,000 tokens while preserving essential state

---

## Benchmark Results

### CursorBench (Cursor's internal benchmark)

| Model | Score |
|-------|-------|
| Composer 2 | 61.3 |
| Composer 1.5 | 44.2 |
| Composer 1 | 38.0 |

Note: CursorBench is NOT publicly reproducible. Measures solution correctness, code quality, efficiency, and interaction behavior. Problem scope roughly doubled from v1 to v3 in both LOC and file count.

### Terminal-Bench 2.0 (Laude Institute, independent)

| Model | Score |
|-------|-------|
| GPT-5.4 | 75.1 |
| Composer 2 | 61.7 |
| Claude Opus 4.6 | 58.0 |
| Claude Opus 4.5 | 52.1 |
| Composer 1.5 | 47.9 |
| Composer 1 | 40.0 |

Tests real-world terminal tasks: directory navigation, script execution, error interpretation, iterative problem-solving. Evaluated using Harbor framework, 5 iterations per model-agent pair, averaged.

### SWE-bench Multilingual (300 tasks, 9 languages)

| Model | Score |
|-------|-------|
| Composer 2 | 73.7 |
| Composer 1.5 | 65.9 |
| Composer 1 | 56.9 |

---

## Comparison: Composer 2 vs Eight (Our Approach)

| Dimension | Composer 2 | Eight (8gent) |
|-----------|-----------|---------------|
| **Base model** | Kimi K2.5 (1T MoE, 32B active) | Qwen 3.5 (local) or OpenRouter cloud |
| **Training** | Continued pretraining + RL on coding trajectories | GRPO fine-tuning (off by default, packages/kernel/) |
| **Context management** | Self-summarization (trained, ~1k tokens) | Checkpoint-restore (git stash snapshots) |
| **Long-horizon** | Self-summarization allows 170+ turn tasks | Checkpoint-verify-revert loop (packages/validation/) |
| **Architecture** | MoE (384 experts, 8 active/token) | Single dense model (Qwen) or cloud API |
| **Cost** | $0.50/M in, $2.50/M out | Free (local Ollama) or free tier (OpenRouter) |
| **Privacy** | Cloud-only, code sent to Cursor servers | Local-first, no data leaves machine by default |
| **Personalization** | IDE settings, project context | 5-layer personalization, memory store, reflection |
| **Self-improvement** | None (static model, updated by Cursor) | Post-session reflection, Bayesian skill confidence, HyperAgent meta-mutation |
| **Open source** | No | Yes |

### Where They Beat Us

1. **Trained context compression** - Self-summarization is strictly better than our checkpoint-restore for maintaining context over very long sessions. They get RL signal on what to remember; we do mechanical git snapshots.
2. **Raw coding benchmarks** - They have a 1T parameter MoE; we run Qwen 3.5 locally. They will beat us on raw code generation quality.
3. **Multi-file edit quality** - Their RL training specifically targets multi-file edits and tool use.
4. **Scale of training data** - Continued pretraining on massive code corpora gives domain-specific knowledge we can't match with LoRA.

### Where We Beat Them

1. **Privacy** - Local-first, no code leaves your machine. Non-negotiable for many developers.
2. **Cost** - Free. Ollama + Qwen 3.5 = zero API cost.
3. **Self-improvement** - Eight gets better every session through reflection and memory. Composer 2 is static between Cursor updates.
4. **Personalization** - 5-layer personalization system, episodic/semantic memory, procedural memory. Composer 2 has none.
5. **Open source** - Anyone can inspect, modify, contribute.
6. **Ecosystem** - 9 Powers (memory, music, worktree orchestration, policy, evolution, healing, entrepreneurship, AST, browser). Composer 2 is a coding model, not an OS.

---

## Training Techniques We Should Adopt

### 1. Self-Summarization (HIGH PRIORITY)

Our checkpoint-restore loop is mechanical - it snapshots state via git stash. Cursor proved that training the model itself to compress context is 50% better at preserving critical information.

**What to do:** Add a self-summarization step to our GRPO training pipeline. When collecting training trajectories, insert summarization checkpoints. Use the task outcome reward to train the summarization quality. This can be done in `packages/kernel/training.ts`.

**Estimated effort:** Medium. Requires modifying the GRPO batch collection to insert summarization turns and propagate rewards to summary tokens.

### 2. Long-Horizon RL Training (HIGH PRIORITY)

Cursor's RL is specifically optimized for long-horizon coding - multi-file edits, terminal loops, iterative debugging. Our GRPO currently collects shorter trajectories.

**What to do:** Extend `packages/kernel/loop.ts` to collect and train on longer trajectories (50+ turns). This requires more compute but directly improves the key weakness.

### 3. Continued Pretraining on Code (MEDIUM PRIORITY)

Cursor did domain-specific continued pretraining before RL. This gives the base model stronger code understanding.

**What to do:** If/when we have compute budget, run continued pretraining on Qwen 3.5 with curated code data before GRPO. For now, this is aspirational - we don't have the compute Cursor does.

### 4. MoE Architecture Exploration (LOW PRIORITY)

The MoE architecture gives Composer 2 massive stored knowledge with efficient inference. Worth monitoring but not actionable for us right now - we depend on upstream model releases.

---

## Their "Long-Term Planning" vs Our Checkpoint-Restore

### Cursor's Approach: Self-Summarization

- Model is trained to decide what context matters
- Compresses 100k+ tokens to ~1k tokens
- RL ensures summaries preserve task-critical information
- Allows 170+ turn tasks without context window overflow
- Weakness: lossy by design, model might drop something important

### Our Approach: Checkpoint-Restore

- Git stash snapshots at validation checkpoints (`packages/validation/`)
- Full filesystem state preserved, nothing lost
- Can revert to any checkpoint on failure
- No context compression needed - just restore and retry
- Weakness: doesn't help with LLM context window limits, mechanical not intelligent

### Hybrid Approach (Recommended)

Combine both: use our checkpoint-restore for filesystem state recovery, but add trained self-summarization for LLM context management. The checkpoint gives us safety (we can always revert), while self-summarization gives us reach (we can work on longer tasks without losing track).

**Implementation path:**
1. Add summarization prompts to Eight's agent loop in `packages/eight/agent.ts`
2. When context approaches 80% of window, trigger self-summarization
3. Collect (summary, outcome) pairs during GRPO training
4. Train the summarization quality through task reward

---

## Key Takeaways

1. **Self-summarization is the technique to steal.** It's the highest-ROI innovation in the report.
2. **MoE base models are the future for coding.** 1T params stored, 32B active - this is where the industry is heading.
3. **Our advantages are real but different.** Privacy, cost, self-improvement, personalization - these matter to different users than Cursor targets.
4. **Don't compete on raw benchmarks.** We will lose on SWE-bench against a 1T MoE. Compete on the experience: free, local, self-improving, personal.
5. **The base model choice matters enormously.** Cursor's biggest move was picking Kimi K2.5. Monitor Qwen, Llama, and other open MoE releases for our next base model upgrade.

---

## Sources

- [Introducing Composer 2 - Cursor Blog](https://cursor.com/blog/composer-2)
- [Self-Summarization - Cursor Blog](https://cursor.com/blog/self-summarization)
- [VentureBeat: Composer 2 beats Opus 4.6](https://venturebeat.com/technology/cursors-new-coding-model-composer-2-is-here-it-beats-claude-opus-4-6-but)
- [The New Stack: Composer 2 benchmarks](https://thenewstack.io/cursors-composer-2-beats-opus/)
- [DevOps.com: Frontier-Level Coding Performance](https://devops.com/cursor-ships-composer-2-frontier-level-coding-performance-at-a-fraction-of-the-cost/)
- [VentureBeat: Built on Chinese AI model](https://venturebeat.com/technology/cursors-composer-2-was-secretly-built-on-a-chinese-ai-model-and-it-exposes-a)
- [How Cursor Built Composer 2 on Kimi K2.5](https://getaibook.com/blog/cursor-composer-2-is-built-on-kimi-k2-5)
- [WinBuzzer: Composer 2 efficiency](https://winbuzzer.com/2026/03/20/cursor-unveils-composer-2-for-cheaper-ai-coding-xcxwbn/)
- [BuildFastWithAI: Benchmarks and Review](https://www.buildfastwithai.com/blogs/cursor-composer-2-review-2026)
