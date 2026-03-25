#!/usr/bin/env bun
/**
 * Unsloth RL Training Script for Qwen3.5
 *
 * Wraps Unsloth's GRPO training for CLI use with 8gent's judge format.
 * Requires: pip install unsloth, Python 3.10+, 8GB+ VRAM GPU.
 *
 * Usage:
 *   bun run scripts/train-with-unsloth.ts --model qwen3.5 --dataset .8gent/training/
 *   bun run scripts/train-with-unsloth.ts --dry-run
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "util";
import { $ } from "bun";

// -- CLI args ---------------------------------------------------------------

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    model: { type: "string", default: "qwen3.5" },
    dataset: { type: "string", default: ".8gent/training/" },
    output: { type: "string", default: ".8gent/kernel/unsloth-output/" },
    epochs: { type: "string", default: "1" },
    "dry-run": { type: "boolean", default: false },
    "export-gguf": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`
Usage: bun run scripts/train-with-unsloth.ts [options]

Options:
  --model <name>     Base model (default: qwen3.5)
  --dataset <path>   Training data directory (default: .8gent/training/)
  --output <path>    Output directory (default: .8gent/kernel/unsloth-output/)
  --epochs <n>       Training epochs (default: 1)
  --dry-run          Validate setup without training
  --export-gguf      Export to GGUF after training (for Ollama)
  --help             Show this help
  `);
  process.exit(0);
}

// -- Model mapping ----------------------------------------------------------

const MODEL_MAP: Record<string, string> = {
  "qwen3.5": "unsloth/Qwen2.5-3B-Instruct",
  "qwen3.5-1.5b": "unsloth/Qwen2.5-1.5B-Instruct",
  "qwen3.5-7b": "unsloth/Qwen2.5-7B-Instruct",
};

// -- Preflight checks -------------------------------------------------------

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function checkPython(): Promise<CheckResult> {
  try {
    const result = await $`python3 --version`.text();
    return { name: "Python", ok: true, detail: result.trim() };
  } catch {
    return { name: "Python", ok: false, detail: "python3 not found" };
  }
}

async function checkUnsloth(): Promise<CheckResult> {
  try {
    const result = await $`python3 -c "import unsloth; print(unsloth.__version__)"`.text();
    return { name: "Unsloth", ok: true, detail: `v${result.trim()}` };
  } catch {
    return { name: "Unsloth", ok: false, detail: "Not installed. Run: pip install unsloth" };
  }
}

async function checkGPU(): Promise<CheckResult> {
  try {
    const result = await $`python3 -c "import torch; print(f'{torch.cuda.get_device_name(0)} ({torch.cuda.get_device_properties(0).total_mem // 1024**3}GB)') if torch.cuda.is_available() else print('No CUDA')"`.text();
    const info = result.trim();
    return { name: "GPU", ok: info !== "No CUDA", detail: info };
  } catch {
    return { name: "GPU", ok: false, detail: "torch not available" };
  }
}

function checkDataset(datasetPath: string): CheckResult {
  if (!existsSync(datasetPath)) {
    return { name: "Dataset", ok: false, detail: `${datasetPath} not found` };
  }
  const files = readdirSync(datasetPath).filter(
    (f) => f.endsWith(".json") || f.endsWith(".jsonl")
  );
  if (files.length === 0) {
    return { name: "Dataset", ok: false, detail: "No .json/.jsonl files found" };
  }
  return { name: "Dataset", ok: true, detail: `${files.length} file(s) in ${datasetPath}` };
}

async function runPreflight(datasetPath: string): Promise<boolean> {
  console.log("\n--- Preflight Checks ---\n");
  const checks = await Promise.all([
    checkPython(),
    checkUnsloth(),
    checkGPU(),
    Promise.resolve(checkDataset(datasetPath)),
  ]);

  let allOk = true;
  for (const check of checks) {
    const icon = check.ok ? "[OK]" : "[FAIL]";
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
    if (!check.ok) allOk = false;
  }
  console.log("");
  return allOk;
}

// -- Reward function generation ---------------------------------------------

/**
 * Generates Python reward functions compatible with both Unsloth's GRPO
 * format and our packages/kernel/judge.ts criteria (same 4 dimensions,
 * same weights: exec 0.4, quality 0.2, tools 0.2, directness 0.2).
 */
function generateRewardFunctions(outputDir: string): string {
  const rewardPath = join(outputDir, "reward_functions.py");
  const code = `"""
Reward functions for Unsloth GRPO training.
Mirrors 8gent packages/kernel/judge.ts scoring criteria.
"""
import re


def execution_success_reward(completions: list[str], **kwargs) -> list[float]:
    """Does the response contain executable, syntactically valid code?"""
    rewards = []
    for c in completions:
        score = 0.3
        if re.search(r'\`\`\`\\w*\\n[\\s\\S]+?\`\`\`', c):
            score += 0.3
        if 'undefined' not in c.lower() and 'error' not in c.lower():
            score += 0.2
        if any(kw in c for kw in ['return ', 'export ', 'function ', 'const ']):
            score += 0.2
        rewards.append(min(score, 1.0))
    return rewards


def code_quality_reward(completions: list[str], **kwargs) -> list[float]:
    """Is the code clean, idiomatic, well-structured?"""
    rewards = []
    for c in completions:
        score = 0.3
        if re.search(r':\\s*(string|number|boolean|Record|Array)', c):
            score += 0.2
        if '/**' in c or '//' in c:
            score += 0.15
        fn_count = len(re.findall(r'(function |const \\w+ = (?:async )?\\(|=>)', c))
        if 1 <= fn_count <= 5:
            score += 0.2
        if len(c) > 4000:
            score -= 0.15
        rewards.append(max(0.0, min(score, 1.0)))
    return rewards


def tool_efficiency_reward(completions: list[str], **kwargs) -> list[float]:
    """Were tools used appropriately without waste?"""
    rewards = []
    for c in completions:
        score = 0.5
        tool_calls = len(re.findall(r'(readFile|writeFile|exec|search|grep)', c))
        if 1 <= tool_calls <= 3:
            score += 0.3
        elif tool_calls > 5:
            score -= 0.2
        if any(w in c.lower() for w in ['because', 'since', 'to find', 'to check']):
            score += 0.2
        rewards.append(max(0.0, min(score, 1.0)))
    return rewards


def directness_reward(completions: list[str], **kwargs) -> list[float]:
    """Was the solution focused and not over-engineered?"""
    rewards = []
    for c in completions:
        score = 0.5
        if 200 <= len(c) <= 1500:
            score += 0.3
        elif len(c) > 3000:
            score -= 0.2
        hedge_count = len(re.findall(
            r'(might|could|perhaps|maybe|alternatively|another approach)', c.lower()
        ))
        score -= hedge_count * 0.05
        if c.strip().startswith(('Here', 'The ', 'I ')):
            score += 0.1
        rewards.append(max(0.0, min(score, 1.0)))
    return rewards


def combined_reward(completions: list[str], **kwargs) -> list[float]:
    """Weighted combination matching packages/kernel/judge.ts weights."""
    ex = execution_success_reward(completions, **kwargs)
    cq = code_quality_reward(completions, **kwargs)
    te = tool_efficiency_reward(completions, **kwargs)
    dr = directness_reward(completions, **kwargs)
    return [round(ex[i]*0.4 + cq[i]*0.2 + te[i]*0.2 + dr[i]*0.2, 3) for i in range(len(completions))]
`;

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(rewardPath, code);
  return rewardPath;
}

// -- Training script generation ---------------------------------------------

function generateTrainingScript(opts: {
  model: string;
  dataset: string;
  output: string;
  epochs: number;
  exportGguf: boolean;
}): string {
  const scriptPath = join(opts.output, "run_training.py");
  const hfModel = MODEL_MAP[opts.model] ?? opts.model;

  const ggufBlock = opts.exportGguf
    ? `
print("Exporting to GGUF (Q4_K_M)...")
model.save_pretrained_gguf("${opts.output}/gguf", tokenizer, quantization_method="q4_k_m")
print("GGUF exported. Import: ollama create eight-custom -f ${opts.output}/gguf/Modelfile")
`
    : "";

  const script = `#!/usr/bin/env python3
"""Auto-generated Unsloth GRPO training script for 8gent kernel."""
from unsloth import FastLanguageModel
import glob, sys
sys.path.insert(0, "${opts.output}")
from reward_functions import combined_reward
from trl import GRPOConfig, GRPOTrainer
from datasets import load_dataset

print("Loading model: ${hfModel}")
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="${hfModel}", max_seq_length=2048, load_in_4bit=True,
)
model = FastLanguageModel.get_peft_model(
    model, r=16,
    target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
    lora_alpha=16, lora_dropout=0, bias="none", use_gradient_checkpointing="unsloth",
)

data_files = glob.glob("${opts.dataset}/*.jsonl") + glob.glob("${opts.dataset}/*.json")
if not data_files:
    print("ERROR: No training data in ${opts.dataset}"); sys.exit(1)
dataset = load_dataset("json", data_files=data_files, split="train")
print(f"Dataset: {len(dataset)} examples from {len(data_files)} file(s)")

trainer = GRPOTrainer(
    model=model, tokenizer=tokenizer, reward_funcs=[combined_reward], train_dataset=dataset,
    args=GRPOConfig(
        output_dir="${opts.output}/checkpoints", num_train_epochs=${opts.epochs},
        per_device_train_batch_size=1, gradient_accumulation_steps=4,
        learning_rate=5e-6, max_completion_length=1024, num_generations=4,
        logging_steps=1, save_steps=50, report_to="none",
    ),
)
print("Starting GRPO training..."); trainer.train(); print("Training complete.")
model.save_pretrained("${opts.output}/lora-adapter")
tokenizer.save_pretrained("${opts.output}/lora-adapter")
print("LoRA adapter saved to ${opts.output}/lora-adapter")
${ggufBlock}`;

  writeFileSync(scriptPath, script);
  return scriptPath;
}

// -- Main -------------------------------------------------------------------

async function main() {
  const model = args.model ?? "qwen3.5";
  const dataset = args.dataset ?? ".8gent/training/";
  const output = args.output ?? ".8gent/kernel/unsloth-output/";
  const epochs = parseInt(args.epochs ?? "1", 10);
  const dryRun = args["dry-run"] ?? false;
  const exportGguf = args["export-gguf"] ?? false;

  console.log(`\n8gent Unsloth RL Training`);
  console.log(`  Model:   ${model} -> ${MODEL_MAP[model] ?? model}`);
  console.log(`  Dataset: ${dataset}`);
  console.log(`  Output:  ${output}`);
  console.log(`  Epochs:  ${epochs}`);
  console.log(`  GGUF:    ${exportGguf ? "yes" : "no"}`);
  console.log(`  Mode:    ${dryRun ? "DRY RUN" : "TRAINING"}`);

  const allOk = await runPreflight(dataset);

  if (dryRun) {
    console.log(allOk
      ? "Dry run passed. All checks OK. Ready to train."
      : "Dry run found issues. Fix the above before training.");
    process.exit(allOk ? 0 : 1);
  }

  if (!allOk) {
    console.error("Preflight checks failed. Run with --dry-run to diagnose.");
    process.exit(1);
  }

  mkdirSync(output, { recursive: true });
  const rewardPath = generateRewardFunctions(output);
  console.log(`Generated reward functions: ${rewardPath}`);

  const scriptPath = generateTrainingScript({ model, dataset, output, epochs, exportGguf });
  console.log(`Generated training script: ${scriptPath}`);

  console.log("\nLaunching Unsloth training...\n");
  const proc = Bun.spawn(["python3", scriptPath], { stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`\nTraining failed with exit code ${exitCode}`);
    process.exit(exitCode);
  }

  console.log("\nTraining complete. Output at:", output);
  if (exportGguf) {
    console.log(`Import to Ollama:\n  ollama create eight-custom -f ${output}/gguf/Modelfile`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
