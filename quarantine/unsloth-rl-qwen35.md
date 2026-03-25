# Quarantine: Unsloth RL Training for Qwen3.5

## Source
- X: @UnslothAI (Mar 23, 2026)
- LinkedIn: Daniel Han, Co-founder @ Unsloth AI
- Links: unsloth.ai/docs/get-start, github.com/unslothai/unsloth
- Colab: colab.research.google.com/github/unsloth (Qwen3-4B GRPO notebook)

## Key Insights
- Train Qwen3.5-2B with RL locally using only 8GB VRAM
- Vision GRPO training - model learns to solve problems autonomously
- Reward functions with reasoning pattern extraction
- Code execution + reward hacking prevention
- 2x faster training, 70% less VRAM vs vanilla
- Supports GGUF export (our Ollama format)

## Relevance to 8gent
- Our kernel fine-tuning pipeline (`packages/kernel/`) uses GRPO
- Our default model IS qwen3.5
- Their reward function pattern matches our `packages/kernel/judge.ts`
- Their training notebook could replace our training proxy approach
- Local RL training = our "free and local by default" principle

## What to Build
1. Integrate Unsloth's GRPO training pattern into `packages/kernel/training.ts`
2. Add Unsloth-compatible reward function format to `packages/kernel/judge.ts`
3. Create a `scripts/train-with-unsloth.ts` that wraps their notebook for CLI use
4. Benchmark: compare our current GRPO approach vs Unsloth's 2x faster claim
