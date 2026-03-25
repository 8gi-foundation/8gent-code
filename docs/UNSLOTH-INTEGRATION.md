# Unsloth RL Training Integration

## What is Unsloth?

Unsloth is an open-source library that accelerates LLM fine-tuning by 2x while using 70% less VRAM. It achieves this through custom CUDA kernels and memory-efficient training loops. For 8gent, it enables local GRPO (Group Relative Policy Optimization) training of Qwen3.5 on consumer GPUs with as little as 8GB VRAM.

## Why integrate?

- Our default model is Qwen3.5 - Unsloth has first-class support for it
- Our kernel pipeline (`packages/kernel/`) already uses GRPO - Unsloth makes it faster
- Local RL training aligns with our "free and local by default" principle
- GGUF export means trained models slot directly into Ollama

## How it compares to packages/kernel/

| Aspect | packages/kernel/ (current) | Unsloth (new) |
|--------|---------------------------|---------------|
| **Training method** | GRPO via training proxy | GRPO via Unsloth native |
| **Judge/reward** | Gemini Flash via OpenRouter | Local Python reward functions |
| **VRAM requirement** | Depends on proxy setup | 8GB minimum (4-bit quantized) |
| **Speed** | Baseline | ~2x faster (claimed) |
| **Dependencies** | Bun + OpenRouter API key | Python + pip + CUDA GPU |
| **Output format** | LoRA adapter | LoRA adapter + optional GGUF |
| **Online requirement** | Yes (judge calls OpenRouter) | No (fully local) |

The two approaches are complementary. `packages/kernel/` handles the collection pipeline and judge scoring during live sessions. Unsloth handles the actual weight updates locally. The reward functions in `scripts/train-with-unsloth.ts` mirror the same four criteria from `packages/kernel/judge.ts` (executionSuccess, codeQuality, toolEfficiency, directness) with matching weights.

## Setup

### Prerequisites

- Python 3.10+
- CUDA-capable GPU with 8GB+ VRAM
- pip (Python package manager)

### Install

```bash
pip install unsloth
```

This pulls in PyTorch, transformers, trl, and Unsloth's custom kernels.

### Verify installation

```bash
bun run scripts/train-with-unsloth.ts --dry-run
```

This checks Python, Unsloth, GPU availability, and dataset presence without training.

### Pull the base model

The training script auto-downloads the model on first run. To pre-pull:

```python
python3 -c "from unsloth import FastLanguageModel; FastLanguageModel.from_pretrained('unsloth/Qwen2.5-3B-Instruct', max_seq_length=2048, load_in_4bit=True)"
```

## Usage

```bash
# Full training run
bun run scripts/train-with-unsloth.ts --model qwen3.5 --dataset .8gent/training/

# With GGUF export for Ollama
bun run scripts/train-with-unsloth.ts --model qwen3.5 --dataset .8gent/training/ --export-gguf

# Dry run (validate only)
bun run scripts/train-with-unsloth.ts --dry-run

# Custom epochs
bun run scripts/train-with-unsloth.ts --model qwen3.5 --epochs 3
```

### Dataset format

Place `.json` or `.jsonl` files in `.8gent/training/`. Each record should have a `prompt` field (and optionally a `completion` field). The GRPO trainer generates completions from the model and scores them with reward functions - it does not require pre-written completions.

### Output

- LoRA adapter: `.8gent/kernel/unsloth-output/lora-adapter/`
- GGUF (if enabled): `.8gent/kernel/unsloth-output/gguf/`
- Checkpoints: `.8gent/kernel/unsloth-output/checkpoints/`

### Import to Ollama

After GGUF export:

```bash
ollama create eight-custom -f .8gent/kernel/unsloth-output/gguf/Modelfile
```

## Status

Quarantine phase - validating the approach before integrating into `packages/kernel/`. See `quarantine/unsloth-rl-qwen35.md` for the evaluation criteria.
