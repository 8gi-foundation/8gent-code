#!/usr/bin/env bun
/**
 * generate-synthetic.ts - frontier-model synthetic corpus generator.
 *
 * Default behaviour (BDH_LIVE unset) writes deterministic placeholder
 * examples so the rest of the pipeline is testable end to end without
 * burning API tokens. Set BDH_LIVE=1 to call the real model via Vercel
 * AI SDK (model id from BDH_DATA_GEN_MODEL, default anthropic/claude-opus-4-7).
 *
 * Usage:
 *   bun run scripts/generate-synthetic.ts --n 1000 --seed 42 --out data/synthetic.jsonl
 */

import type { Decision, OrchestratorInput, TrainingExample } from "../types.ts";
import {
	deterministicId,
	exitHelp,
	isLive,
	nowIso,
	parseArgs,
	sanitiseExample,
	writeJsonl,
} from "./_shared.ts";

const HELP = `
generate-synthetic.ts - frontier-model synthetic corpus generator

  --n        number of examples to generate          (default 1000)
  --seed     deterministic seed                       (default 42)
  --out      output JSONL path                        (required)
  --help     show this message

Env:
  BDH_LIVE=1                 enable real LLM calls (default: stub mode)
  BDH_DATA_GEN_MODEL=...     model id for live mode
                             (default: anthropic/claude-opus-4-7)
`;

const SEED_TEMPLATES: Array<{
	request: string;
	tools: string[];
	vessels: string[];
	decision: Decision;
	concepts: string[];
	reasoning: string[];
}> = [
	{
		request: "rewrite this auth middleware to use the new policy engine",
		tools: ["Read", "Edit", "Bash", "AgentTool"],
		vessels: ["8TO", "8SO"],
		decision: { kind: "agent", target: "8SO", budget: { tokens: 12000, ms: 90000 }, confidence: 0.83 },
		concepts: ["code-edit", "security-sensitive", "policy-engine-context", "vessel-8SO-fits"],
		reasoning: ["Auth touches security boundary", "8SO covers policy review", "Budget allows agent dispatch"],
	},
	{
		request: "what files changed in the last commit",
		tools: ["Bash", "Read"],
		vessels: ["8TO"],
		decision: { kind: "tool", target: "Bash", budget: { tokens: 500, ms: 5000 }, confidence: 0.95 },
		concepts: ["read-only-query", "git-introspection", "low-risk"],
		reasoning: ["Pure read query", "Tool call sufficient", "No vessel needed"],
	},
	{
		request: "summarise the project status",
		tools: ["Read"],
		vessels: ["8EO"],
		decision: { kind: "model", target: "8gent/eight-1.0-q3:14b", budget: { tokens: 4000, ms: 30000 }, confidence: 0.78 },
		concepts: ["summarisation", "no-tool-needed", "context-fits"],
		reasoning: ["Pure language task", "Local model adequate", "No external action"],
	},
	{
		request: "deploy to production",
		tools: ["Bash"],
		vessels: ["8DO"],
		decision: { kind: "clarify", target: "user", budget: { tokens: 1000, ms: 10000 }, confidence: 0.6 },
		concepts: ["high-risk-action", "missing-context", "needs-confirmation"],
		reasoning: ["Production deploy is destructive", "No version specified", "Ask before acting"],
	},
];

function buildSeedExample(seed: number, idx: number): TrainingExample {
	const tpl = SEED_TEMPLATES[idx % SEED_TEMPLATES.length];
	const state: OrchestratorInput = {
		request: tpl.request,
		context: {
			tools_available: tpl.tools,
			vessels_available: tpl.vessels,
			budget_remaining: { tokens: 80000, ms: 600000 },
			history_summary: "synthetic seed - no real session history",
		},
		policy: {
			authority_level: 3,
			deny_actions: ["push_to_main"],
		},
	};
	return {
		id: deterministicId("synth", seed, idx),
		state,
		decision: tpl.decision,
		trace: { concepts_fired: tpl.concepts, reasoning: tpl.reasoning },
		provenance: {
			source: "synthetic",
			model_used: process.env.BDH_DATA_GEN_MODEL || "anthropic/claude-opus-4-7",
			created_at: nowIso(),
			seed,
			notes: "stub - BDH_LIVE not set",
		},
	};
}

async function generateLive(_seed: number, _idx: number): Promise<TrainingExample> {
	// Live path is gated behind BDH_LIVE=1. Real implementation calls
	// generateObject() from the Vercel AI SDK with a Zod schema matching
	// TrainingExample. Until James greenlights API spend, this throws.
	throw new Error("BDH_LIVE=1 set but live generation is not wired in Phase 0; remove the env var to run in stub mode");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) exitHelp(HELP);
	const n = Number(args.n ?? 1000);
	const seed = Number(args.seed ?? 42);
	const out = String(args.out ?? "");
	if (!out) exitHelp(HELP);

	const rows: TrainingExample[] = [];
	for (let i = 0; i < n; i++) {
		const ex = isLive() ? await generateLive(seed, i) : buildSeedExample(seed, i);
		rows.push(sanitiseExample(ex));
	}
	writeJsonl(out, rows);
	process.stdout.write(`wrote ${rows.length} synthetic examples to ${out}\n`);
}

if (import.meta.main) {
	main().catch((e) => {
		process.stderr.write(`generate-synthetic failed: ${(e as Error).message}\n`);
		process.exit(1);
	});
}
