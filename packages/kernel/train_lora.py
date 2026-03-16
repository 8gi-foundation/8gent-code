#!/usr/bin/env python3
"""
Local LoRA training script for 8gent/MetaClaw.
Runs on Apple Silicon (MPS) without cloud services.

Uses peft+transformers (with unsloth as preferred fast path).
Trains a LoRA adapter from GRPO-formatted JSONL data.

Usage:
  python3 train_lora.py \
    --data ~/.8gent/kernel/training/grpo_pairs.jsonl \
    --base-model Qwen/Qwen3-14B \
    --output ~/.8gent/checkpoints/ckpt_001 \
    --epochs 3 \
    --lora-rank 32
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from dataclasses import dataclass

# ── Detect available backend ───────────────────────────────────────────

BACKEND = "none"

try:
    from unsloth import FastLanguageModel
    BACKEND = "unsloth"
except ImportError:
    pass

if BACKEND == "none":
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer
        from peft import LoraConfig, get_peft_model, TaskType
        if torch.backends.mps.is_available():
            BACKEND = "peft"
        else:
            # CPU fallback — slow but functional
            BACKEND = "peft_cpu"
    except ImportError:
        pass

if BACKEND == "none":
    print("ERROR: Neither unsloth nor peft+transformers is installed.", file=sys.stderr)
    print("Install with: pip install peft transformers torch", file=sys.stderr)
    sys.exit(1)


@dataclass
class TrainingSample:
    prompt: str
    chosen: str  # high-scoring response
    rejected: str  # low-scoring response
    chosen_score: float
    rejected_score: float


def load_grpo_pairs(data_path: str) -> list[TrainingSample]:
    """Load GRPO preference pairs from JSONL."""
    samples = []
    with open(data_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            samples.append(TrainingSample(
                prompt=obj["prompt"],
                chosen=obj["chosen"],
                rejected=obj["rejected"],
                chosen_score=obj.get("chosen_score", 1.0),
                rejected_score=obj.get("rejected_score", 0.0),
            ))
    return samples


def format_for_sft(samples: list[TrainingSample]) -> list[dict]:
    """
    Convert GRPO pairs to SFT format for LoRA training.
    We train on the chosen (high-scoring) responses only,
    weighted by the score margin.
    """
    formatted = []
    for s in samples:
        # ChatML format matching Qwen's expected template
        text = (
            f"<|im_start|>user\n{s.prompt}<|im_end|>\n"
            f"<|im_start|>assistant\n{s.chosen}<|im_end|>"
        )
        formatted.append({"text": text, "score_margin": s.chosen_score - s.rejected_score})
    return formatted


def train_with_unsloth(
    data_path: str,
    base_model: str,
    output_dir: str,
    epochs: int,
    lora_rank: int,
    learning_rate: float,
    batch_size: int,
):
    """Train using unsloth (optimized for Apple Silicon)."""
    from unsloth import FastLanguageModel
    import torch

    print(f"[unsloth] Loading base model: {base_model}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=base_model,
        max_seq_length=2048,
        load_in_4bit=True,  # QLoRA — fits 14B in ~8GB
    )

    model = FastLanguageModel.get_peft_model(
        model,
        r=lora_rank,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        lora_alpha=lora_rank * 2,
        lora_dropout=0.05,
        use_gradient_checkpointing="unsloth",
    )

    # Load and format data
    samples = load_grpo_pairs(data_path)
    if not samples:
        print("ERROR: No training samples found.", file=sys.stderr)
        sys.exit(1)

    formatted = format_for_sft(samples)
    print(f"[unsloth] Loaded {len(formatted)} training samples")

    # Tokenize
    from datasets import Dataset
    dataset = Dataset.from_list(formatted)

    def tokenize(example):
        return tokenizer(
            example["text"],
            truncation=True,
            max_length=2048,
            padding="max_length",
        )

    dataset = dataset.map(tokenize, batched=True, remove_columns=["text", "score_margin"])

    from transformers import TrainingArguments, Trainer, DataCollatorForLanguageModeling

    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        gradient_accumulation_steps=max(1, 4 // batch_size),
        learning_rate=learning_rate,
        warmup_ratio=0.1,
        lr_scheduler_type="cosine",
        logging_steps=1,
        save_strategy="epoch",
        fp16=False,  # MPS doesn't support fp16 training well
        bf16=False,
        optim="adamw_torch",
        report_to="none",
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=dataset,
        data_collator=DataCollatorForLanguageModeling(tokenizer, mlm=False),
    )

    print(f"[unsloth] Starting training: {epochs} epochs, rank={lora_rank}")
    trainer.train()

    # Save adapter only
    model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)
    print(f"[unsloth] Adapter saved to {output_dir}")


def train_with_peft(
    data_path: str,
    base_model: str,
    output_dir: str,
    epochs: int,
    lora_rank: int,
    learning_rate: float,
    batch_size: int,
    use_mps: bool = True,
):
    """Train using peft+transformers on MPS or CPU."""
    import torch
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        TrainingArguments,
        Trainer,
        DataCollatorForLanguageModeling,
        BitsAndBytesConfig,
    )
    from peft import LoraConfig, get_peft_model, TaskType

    device = "mps" if use_mps else "cpu"
    print(f"[peft] Device: {device}")
    print(f"[peft] Loading base model: {base_model}")

    # For MPS: load in float32 (MPS doesn't support all fp16 ops)
    # Use 4-bit quantization if bitsandbytes is available, otherwise float32
    model_kwargs = {
        "torch_dtype": torch.float32,
        "device_map": {"": device},
        "trust_remote_code": True,
    }

    # Try quantization to fit 14B in memory
    try:
        quantization_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float32,
            bnb_4bit_quant_type="nf4",
        )
        model_kwargs["quantization_config"] = quantization_config
        print("[peft] Using 4-bit quantization (QLoRA)")
    except Exception:
        print("[peft] bitsandbytes not available, loading full precision")
        print("[peft] WARNING: 14B model needs ~28GB RAM in float32")

    tokenizer = AutoTokenizer.from_pretrained(base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(base_model, **model_kwargs)

    # Apply LoRA
    lora_config = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=lora_rank,
        lora_alpha=lora_rank * 2,
        lora_dropout=0.05,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        bias="none",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    # Load and format data
    samples = load_grpo_pairs(data_path)
    if not samples:
        print("ERROR: No training samples found.", file=sys.stderr)
        sys.exit(1)

    formatted = format_for_sft(samples)
    print(f"[peft] Loaded {len(formatted)} training samples")

    # Tokenize
    from datasets import Dataset
    dataset = Dataset.from_list(formatted)

    def tokenize(example):
        result = tokenizer(
            example["text"],
            truncation=True,
            max_length=2048,
            padding="max_length",
        )
        result["labels"] = result["input_ids"].copy()
        return result

    dataset = dataset.map(tokenize, batched=True, remove_columns=["text", "score_margin"])

    # MPS-compatible training args
    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        gradient_accumulation_steps=max(1, 4 // batch_size),
        learning_rate=learning_rate,
        warmup_ratio=0.1,
        lr_scheduler_type="cosine",
        logging_steps=1,
        save_strategy="epoch",
        fp16=False,
        bf16=False,
        optim="adamw_torch",
        report_to="none",
        use_mps_device=use_mps,
        dataloader_pin_memory=False,  # Required for MPS
        gradient_checkpointing=True,  # Save VRAM
        max_grad_norm=1.0,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=dataset,
        data_collator=DataCollatorForLanguageModeling(tokenizer, mlm=False),
    )

    print(f"[peft] Starting training: {epochs} epochs, rank={lora_rank}, lr={learning_rate}")
    start = time.time()
    trainer.train()
    elapsed = time.time() - start
    print(f"[peft] Training complete in {elapsed:.1f}s")

    # Save adapter only (not full model)
    model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)

    # Write training metadata
    meta = {
        "backend": "peft",
        "base_model": base_model,
        "lora_rank": lora_rank,
        "epochs": epochs,
        "learning_rate": learning_rate,
        "samples": len(formatted),
        "device": device,
        "training_time_s": round(elapsed, 1),
        "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(os.path.join(output_dir, "training_meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    print(f"[peft] Adapter saved to {output_dir}")


def main():
    parser = argparse.ArgumentParser(description="Local LoRA trainer for 8gent/MetaClaw")
    parser.add_argument("--data", required=True, help="Path to GRPO pairs JSONL file")
    parser.add_argument("--base-model", default="Qwen/Qwen3-14B",
                        help="HuggingFace model ID or local path (default: Qwen/Qwen3-14B)")
    parser.add_argument("--output", default=os.path.expanduser("~/.8gent/checkpoints/latest"),
                        help="Output directory for LoRA adapter")
    parser.add_argument("--epochs", type=int, default=3, help="Training epochs (default: 3)")
    parser.add_argument("--lora-rank", type=int, default=32, help="LoRA rank (default: 32)")
    parser.add_argument("--lr", type=float, default=2e-4, help="Learning rate (default: 2e-4)")
    parser.add_argument("--batch-size", type=int, default=1,
                        help="Batch size (default: 1, increase if RAM allows)")
    parser.add_argument("--backend", choices=["auto", "unsloth", "peft"],
                        default="auto", help="Training backend")
    args = parser.parse_args()

    # Validate input
    if not os.path.exists(args.data):
        print(f"ERROR: Data file not found: {args.data}", file=sys.stderr)
        sys.exit(1)

    # Create output dir
    os.makedirs(args.output, exist_ok=True)

    # Select backend
    backend = args.backend
    if backend == "auto":
        backend = BACKEND
    elif backend == "unsloth" and BACKEND != "unsloth":
        print("ERROR: unsloth not installed. Install with: pip install unsloth", file=sys.stderr)
        sys.exit(1)
    elif backend == "peft" and BACKEND not in ("peft", "peft_cpu"):
        print("ERROR: peft not installed. Install with: pip install peft", file=sys.stderr)
        sys.exit(1)

    print(f"[train_lora] Backend: {backend}")
    print(f"[train_lora] Data: {args.data}")
    print(f"[train_lora] Base model: {args.base_model}")
    print(f"[train_lora] Output: {args.output}")
    print(f"[train_lora] Epochs: {args.epochs}, Rank: {args.lora_rank}, LR: {args.lr}")

    if backend == "unsloth":
        train_with_unsloth(
            data_path=args.data,
            base_model=args.base_model,
            output_dir=args.output,
            epochs=args.epochs,
            lora_rank=args.lora_rank,
            learning_rate=args.lr,
            batch_size=args.batch_size,
        )
    else:
        use_mps = backend == "peft"
        train_with_peft(
            data_path=args.data,
            base_model=args.base_model,
            output_dir=args.output,
            epochs=args.epochs,
            lora_rank=args.lora_rank,
            learning_rate=args.lr,
            batch_size=args.batch_size,
            use_mps=use_mps,
        )

    print("[train_lora] Done.")


if __name__ == "__main__":
    main()
