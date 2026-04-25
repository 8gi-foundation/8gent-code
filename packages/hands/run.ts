#!/usr/bin/env bun
// 8gent-hands CLI entrypoint.
//
// Usage:
//   bun run packages/hands/run.ts "take a screenshot"
//
// Prints a single JSON object (RunResult) to stdout. All planner / wrapper
// chatter goes to stderr so the Swift app can JSON-decode stdout cleanly.
//
// Env:
//   HANDS_PLANNER  "llm" (default with stub fallback) | "stub" (force stub)
//   HANDS_BIN      override path to cua-driver
//   HANDS_IMG_DIR  default /tmp; screenshots land here as 8gh-<ts>.png

import { mkdirSync, existsSync } from "node:fs";

import { callTool } from "./index.ts";
import { planWithLlm, planWithStub } from "./plan.ts";
import type { PlannedStep, RunResult, StepResult } from "./types.ts";

function eprint(msg: string): void {
  process.stderr.write(`[hands] ${msg}\n`);
}

async function getPlan(
  prompt: string,
): Promise<{ plan: PlannedStep[]; mode: "llm" | "stub"; model?: string }> {
  const forced = process.env.HANDS_PLANNER;
  if (forced === "stub") {
    return { plan: planWithStub(prompt), mode: "stub" };
  }

  eprint("planning with LLM...");
  const llm = await planWithLlm(prompt);
  if (llm && llm.plan.length > 0) {
    return { plan: llm.plan, mode: "llm", model: llm.model };
  }
  eprint("LLM planner unavailable or empty, falling back to stub");
  return { plan: planWithStub(prompt), mode: "stub" };
}

function tsSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function executeStep(step: PlannedStep): Promise<StepResult> {
  const startedAt = Date.now();

  // Screenshot tools produce an image stream - route to a file on disk.
  let imageOut: string | undefined;
  if (step.tool === "screenshot" || step.tool === "zoom") {
    const dir = process.env.HANDS_IMG_DIR ?? "/tmp";
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    imageOut = `${dir}/8gh-${tsSlug()}.png`;
  }

  try {
    const r = await callTool(step.tool, step.args, { imageOut });
    return {
      step,
      ok: r.ok,
      output: r.stdout,
      imagePath: r.imagePath,
      error: r.ok ? undefined : r.stderr || `exit ${r.exitCode}`,
      durationMs: r.durationMs,
    };
  } catch (err) {
    return {
      step,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          error: "no prompt; usage: bun run packages/hands/run.ts \"<prompt>\"",
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(2);
  }

  const startedAt = new Date();
  const { plan, mode, model } = await getPlan(prompt);

  const results: StepResult[] = [];
  if (plan.length === 0) {
    eprint("planner returned no steps");
  }
  for (const step of plan) {
    eprint(`-> ${step.tool} ${JSON.stringify(step.args)}`);
    // eslint-disable-next-line no-await-in-loop -- steps are inherently sequential
    results.push(await executeStep(step));
  }

  const result: RunResult = {
    prompt,
    plannerMode: mode,
    plannerModel: model,
    plan,
    results,
    ok: plan.length > 0 && results.every((r) => r.ok),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[hands] fatal: ${String(err)}\n`);
  process.exit(3);
});
