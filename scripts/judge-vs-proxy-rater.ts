/**
 * Judge vs frontier-proxy-rater agreement.
 *
 * Takes the Day-3 run JSONL, samples 30 turn-level verdicts at random
 * (seed 0x8C1 for reproducibility), and asks a frontier model (Claude
 * Sonnet 4.6 via Anthropic, or via OpenRouter as fallback) whether the
 * goal was achieved at each sampled turn. Compares against the
 * FailoverJudge's decision and reports agreement %.
 *
 * Gate criterion (8EO, boardroom 2026-05-16):
 *   - >= 70% agreement: PASS, ship Friday as planned.
 *   - <  70% agreement: FAIL, ship behind `/go --experimental` flag.
 *
 * Honest caveat: this "human" rater is a frontier-model proxy because
 * James can't hand-rate 30 trajectories in this session. We surface 5
 * sample trajectories raw so he can spot-check the proxy's calibration.
 *
 * Output:
 *   eval/results/<DATE>-day3-agreement.md
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const RUN_DATE = "2026-05-16";
const RESULTS_DIR = "eval/results";
const RUN_JSONL = join(RESULTS_DIR, `${RUN_DATE}-day3-run.jsonl`);
const AGREEMENT_MD = join(RESULTS_DIR, `${RUN_DATE}-day3-agreement.md`);

const SAMPLE_SIZE = 30;
const RNG_SEED = 0x8c1;

const PROXY_MODEL_ANTHROPIC = "claude-sonnet-4-6";
const PROXY_MODEL_OPENROUTER = "anthropic/claude-sonnet-4-6";
// Local fallback proxy (Plan C). Different family from both executor (qwen)
// and judge (gemma), so collusion is bounded but NOT eliminated. Mark the
// report DEGRADED when this path is used and tell James he should rerun
// with a frontier proxy when an API key is available.
const PROXY_MODEL_APPLE = "apple-foundationmodel";
const APFEL_BASE_URL = process.env.APFEL_BASE_URL ?? "http://localhost:11435/v1";

// ----- types -----------------------------------------------------------------

interface TurnVerdict {
	turn: number;
	summary: string;
	decision: string;
	confidence: number;
	judgeSummary: string;
}

interface TaskResult {
	taskId: string;
	category: string;
	difficulty?: string;
	goal?: string;
	skipped: boolean;
	skipReason?: string;
	receipt?: any;
	verification?: { passed: boolean; exitCode: number; stdout: string; stderr: string };
	turnVerdicts: TurnVerdict[];
}

interface SampledVerdict {
	taskId: string;
	taskGoal: string;
	turn: number;
	turnSummary: string;
	judgeDecision: string;
	judgeConfidence: number;
	judgeAchieved: boolean; // decision === "satisfied"
}

interface ProxyVerdict {
	achieved: boolean;
	reasoning: string;
}

// ----- deterministic PRNG (mulberry32) ---------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function sampleWithoutReplacement<T>(arr: T[], n: number, rng: () => number): T[] {
	const copy = arr.slice();
	const out: T[] = [];
	const target = Math.min(n, copy.length);
	for (let i = 0; i < target; i++) {
		const idx = Math.floor(rng() * copy.length);
		out.push(copy.splice(idx, 1)[0]);
	}
	return out;
}

// ----- proxy rater -----------------------------------------------------------

const PROXY_PROMPT = (args: { goal: string; turnSummary: string }) =>
	`You are a rigorous evaluator. Decide whether the agent has achieved the goal at this turn.

GOAL:
${args.goal}

AGENT TURN SUMMARY:
${args.turnSummary}

Respond ONLY with JSON, no prose, no markdown:
{"achieved": true|false, "reasoning": "<one short sentence, no em dashes>"}`;

async function callAnthropic(key: string, prompt: string): Promise<ProxyVerdict> {
	const resp = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: PROXY_MODEL_ANTHROPIC,
			max_tokens: 200,
			messages: [{ role: "user", content: prompt }],
		}),
	});
	if (!resp.ok) {
		throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
	}
	const data = (await resp.json()) as any;
	const text: string = data?.content?.[0]?.text ?? "";
	return parseProxyVerdict(text);
}

async function callApfel(prompt: string): Promise<ProxyVerdict> {
	const resp = await fetch(`${APFEL_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: PROXY_MODEL_APPLE,
			max_tokens: 200,
			messages: [{ role: "user", content: prompt }],
		}),
	});
	if (!resp.ok) {
		throw new Error(`Apfel ${resp.status}: ${await resp.text()}`);
	}
	const data = (await resp.json()) as any;
	const text: string = data?.choices?.[0]?.message?.content ?? "";
	return parseProxyVerdict(text);
}

async function callOpenRouter(key: string, prompt: string): Promise<ProxyVerdict> {
	const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: PROXY_MODEL_OPENROUTER,
			max_tokens: 200,
			messages: [{ role: "user", content: prompt }],
		}),
	});
	if (!resp.ok) {
		throw new Error(`OpenRouter ${resp.status}: ${await resp.text()}`);
	}
	const data = (await resp.json()) as any;
	const text: string = data?.choices?.[0]?.message?.content ?? "";
	return parseProxyVerdict(text);
}

function parseProxyVerdict(text: string): ProxyVerdict {
	// Strip code fences if present.
	const cleaned = text.trim().replace(/^```(?:json)?\s*/, "").replace(/```$/, "").trim();
	// Find first { ... } block.
	const match = cleaned.match(/\{[\s\S]*\}/);
	if (!match) throw new Error(`No JSON in proxy response: ${text.slice(0, 200)}`);
	const obj = JSON.parse(match[0]);
	return {
		achieved: Boolean(obj.achieved),
		reasoning: String(obj.reasoning ?? ""),
	};
}

// ----- main ------------------------------------------------------------------

async function main() {
	mkdirSync(RESULTS_DIR, { recursive: true });

	if (!existsSync(RUN_JSONL)) {
		console.error(`[agreement] missing ${RUN_JSONL}. Run scripts/run-eval-set.ts first.`);
		process.exit(2);
	}

	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	const openrouterKey = process.env.OPENROUTER_API_KEY;
	const allowApfelFallback = process.env.PROXY_ALLOW_LOCAL === "1";

	let rater: { name: string; model: string; degraded: boolean; call: (p: string) => Promise<ProxyVerdict> };
	if (anthropicKey) {
		rater = {
			name: "anthropic",
			model: PROXY_MODEL_ANTHROPIC,
			degraded: false,
			call: (p) => callAnthropic(anthropicKey, p),
		};
	} else if (openrouterKey) {
		rater = {
			name: "openrouter",
			model: PROXY_MODEL_OPENROUTER,
			degraded: false,
			call: (p) => callOpenRouter(openrouterKey, p),
		};
	} else if (allowApfelFallback) {
		rater = {
			name: "apfel",
			model: PROXY_MODEL_APPLE,
			degraded: true,
			call: (p) => callApfel(p),
		};
		console.warn("[agreement] WARNING: using local apfel as proxy fallback (PROXY_ALLOW_LOCAL=1). Report will be marked DEGRADED.");
	} else {
		console.error("[agreement] BLOCKER: no proxy rater available.");
		console.error("[agreement] Set one of:");
		console.error("[agreement]   export ANTHROPIC_API_KEY=sk-ant-...");
		console.error("[agreement]   export OPENROUTER_API_KEY=sk-or-...");
		console.error("[agreement]   export PROXY_ALLOW_LOCAL=1   # use local apfel, degraded report");
		writeFileSync(
			AGREEMENT_MD,
			[
				`# Day-3 Judge-vs-Proxy Agreement — ${RUN_DATE}`,
				"",
				"## Verdict",
				"",
				"**INCONCLUSIVE — proxy rater not available.**",
				"",
				"Neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY was set in the run environment, and the local apfel fallback was not enabled (PROXY_ALLOW_LOCAL=1).",
				"The gate criterion cannot be computed. Recommendation: ship behind `/go --experimental` flag pending a re-run with proxy access.",
				"",
				"## Remediation",
				"",
				"```bash",
				"export ANTHROPIC_API_KEY=sk-ant-...  # or",
				"export OPENROUTER_API_KEY=sk-or-...  # or for a degraded local-only check:",
				"export PROXY_ALLOW_LOCAL=1",
				"bun scripts/judge-vs-proxy-rater.ts",
				"```",
				"",
			].join("\n"),
		);
		process.exit(3);
	}

	console.log(`[agreement] proxy rater: ${rater.name} (${rater.model})${rater.degraded ? " [DEGRADED]" : ""}`);

	// Load run results.
	const lines = readFileSync(RUN_JSONL, "utf8").split("\n").filter((l) => l.trim());
	const results: TaskResult[] = lines.map((l) => JSON.parse(l));
	const ran = results.filter((r) => !r.skipped);

	// Build pool of turn-level verdicts.
	const pool: SampledVerdict[] = [];
	for (const r of ran) {
		const goal = r.goal ?? r.receipt?.goal ?? `(task ${r.taskId})`;
		for (const v of r.turnVerdicts) {
			pool.push({
				taskId: r.taskId,
				taskGoal: goal,
				turn: v.turn,
				turnSummary: v.summary,
				judgeDecision: v.decision,
				judgeConfidence: v.confidence,
				judgeAchieved: v.decision === "satisfied",
			});
		}
	}

	console.log(`[agreement] verdict pool: ${pool.length} turn verdicts across ${ran.length} tasks`);

	if (pool.length === 0) {
		writeFileSync(
			AGREEMENT_MD,
			[
				`# Day-3 Judge-vs-Proxy Agreement — ${RUN_DATE}`,
				"",
				"## Verdict",
				"",
				"**INCONCLUSIVE — no turn verdicts in run results.**",
				"",
				`Run ${RUN_JSONL} contains 0 turn-level verdicts. Either all tasks were skipped or the loop failed before judge invocation. Recommendation: ship behind \`/go --experimental\` flag.`,
			].join("\n"),
		);
		process.exit(3);
	}

	const rng = mulberry32(RNG_SEED);
	const sample = sampleWithoutReplacement(pool, SAMPLE_SIZE, rng);
	console.log(`[agreement] sampled ${sample.length} verdicts (seed 0x${RNG_SEED.toString(16)})`);

	// Run proxy rater on each.
	const rated: Array<SampledVerdict & { proxy: ProxyVerdict; agree: boolean; error?: string }> = [];
	for (let i = 0; i < sample.length; i++) {
		const s = sample[i];
		const prompt = PROXY_PROMPT({ goal: s.taskGoal, turnSummary: s.turnSummary });
		try {
			const proxy = await rater.call(prompt);
			const agree = proxy.achieved === s.judgeAchieved;
			rated.push({ ...s, proxy, agree });
			console.log(`[agreement] ${i + 1}/${sample.length} task=${s.taskId} t=${s.turn} judge=${s.judgeAchieved} proxy=${proxy.achieved} agree=${agree}`);
		} catch (err: any) {
			rated.push({
				...s,
				proxy: { achieved: false, reasoning: `error: ${err.message}` },
				agree: false,
				error: err.message,
			});
			console.log(`[agreement] ${i + 1}/${sample.length} task=${s.taskId} ERROR: ${err.message}`);
		}
	}

	const agreeCount = rated.filter((r) => r.agree).length;
	const errorCount = rated.filter((r) => r.error).length;
	const validCount = rated.length - errorCount;
	const agreementPct = validCount > 0 ? (agreeCount / validCount) * 100 : 0;
	const passGate = agreementPct >= 70;

	// Per-task breakdown.
	const perTask: Record<string, { total: number; agree: number }> = {};
	for (const r of rated) {
		const entry = (perTask[r.taskId] ||= { total: 0, agree: 0 });
		entry.total += 1;
		if (r.agree) entry.agree += 1;
	}

	const md: string[] = [];
	md.push(`# Day-3 Judge-vs-Proxy Agreement — ${RUN_DATE}`);
	md.push("");
	md.push("## Verdict");
	md.push("");
	const degradedSuffix = rater.degraded ? " (DEGRADED rater — see caveat)" : "";
	if (passGate) {
		md.push(`**PASS - ship Friday as planned${degradedSuffix}.** Judge-vs-proxy agreement ${agreementPct.toFixed(1)}% >= 70% gate threshold.`);
	} else {
		md.push(`**FAIL - ship behind \`/go --experimental\` flag${degradedSuffix}.** Judge-vs-proxy agreement ${agreementPct.toFixed(1)}% < 70% gate threshold.`);
	}
	md.push("");
	md.push("## Honest caveat");
	md.push("");
	if (rater.degraded) {
		md.push(`The "human" rater here is a LOCAL fallback (${rater.model} via apfel) because no frontier API key was available. This is a degraded check: same-family bias risk. James MUST hand-rate the 5 sample trajectories below; if he disagrees with the local rater on >1 of 5, treat this entire report as inconclusive and re-run with ANTHROPIC_API_KEY or OPENROUTER_API_KEY before shipping.`);
	} else {
		md.push(`The "human" rater here is a frontier-model proxy (${rater.model} via ${rater.name}). James should hand-rate the 5 sample trajectories below as a calibration check. If James's hand-rating disagrees with the proxy on >1 of 5, the proxy is biased and this report is invalid.`);
	}
	md.push("");
	md.push("## Numbers");
	md.push("");
	md.push(`- **Sampled verdicts:** ${rated.length} (seed 0x${RNG_SEED.toString(16)})`);
	md.push(`- **Agreement:** ${agreeCount}/${validCount} valid = ${agreementPct.toFixed(1)}%`);
	md.push(`- **Errors:** ${errorCount}`);
	md.push(`- **Proxy model:** ${rater.model} via ${rater.name}${rater.degraded ? " [DEGRADED]" : ""}`);
	md.push(`- **Judge model:** local FailoverJudge (gemma-4-26b-a4b via lmstudio)`);
	const judgeAchievedCount = rated.filter((r) => r.judgeAchieved).length;
	const proxyAchievedCount = rated.filter((r) => r.proxy.achieved && !r.error).length;
	md.push(`- **Judge said achieved:** ${judgeAchievedCount}/${rated.length} (${((judgeAchievedCount / rated.length) * 100).toFixed(0)}%)`);
	md.push(`- **Proxy said achieved:** ${proxyAchievedCount}/${validCount} (${((proxyAchievedCount / Math.max(1, validCount)) * 100).toFixed(0)}%)`);
	if (judgeAchievedCount === 0 || judgeAchievedCount === rated.length) {
		md.push("");
		md.push(`> **CALIBRATION WARNING:** judge verdicts are all one class (${judgeAchievedCount === 0 ? "all NOT achieved" : "all achieved"}). High agreement is trivial in this case. Hand-rate the 5 samples to confirm the judge is actually discriminating.`);
	}
	md.push("");
	md.push("## Per-task agreement");
	md.push("");
	md.push("| Task | Sampled turns | Agree | Disagree |");
	md.push("|------|---------------|-------|----------|");
	for (const [taskId, e] of Object.entries(perTask)) {
		md.push(`| ${taskId} | ${e.total} | ${e.agree} | ${e.total - e.agree} |`);
	}
	md.push("");
	md.push("## All sampled verdicts");
	md.push("");
	md.push("| # | Task | Turn | Judge | Proxy | Agree |");
	md.push("|---|------|------|-------|-------|-------|");
	rated.forEach((r, i) => {
		md.push(`| ${i + 1} | ${r.taskId} | ${r.turn} | ${r.judgeAchieved} (conf ${r.judgeConfidence.toFixed(2)}) | ${r.proxy.achieved} | ${r.agree ? "yes" : "no"} |`);
	});
	md.push("");
	md.push("## 5 sample trajectories for James to hand-rate");
	md.push("");
	md.push("Spot-check these. If your gut disagrees with the proxy on >1 of 5, the agreement number is suspect.");
	md.push("");
	for (let i = 0; i < Math.min(5, rated.length); i++) {
		const r = rated[i];
		md.push(`### Sample ${i + 1}: ${r.taskId} turn ${r.turn}`);
		md.push("");
		md.push(`**Goal:** ${r.taskGoal}`);
		md.push("");
		md.push("**Turn summary (what the agent did):**");
		md.push("```");
		md.push(r.turnSummary.slice(0, 1500));
		md.push("```");
		md.push("");
		md.push(`**Judge verdict:** ${r.judgeAchieved ? "ACHIEVED" : "NOT ACHIEVED"} (confidence ${r.judgeConfidence.toFixed(2)})`);
		md.push("");
		md.push(`**Proxy verdict:** ${r.proxy.achieved ? "ACHIEVED" : "NOT ACHIEVED"}`);
		md.push("");
		md.push(`**Proxy reasoning:** ${r.proxy.reasoning}`);
		md.push("");
		md.push(`**Agreement:** ${r.agree ? "agree" : "DISAGREE"}`);
		md.push("");
		md.push("---");
		md.push("");
	}

	writeFileSync(AGREEMENT_MD, md.join("\n") + "\n");
	console.log(`\n[agreement] report at ${AGREEMENT_MD}`);
	console.log(`[agreement] VERDICT: ${passGate ? "PASS" : "FAIL"} (${agreementPct.toFixed(1)}%)`);
}

main().catch((err) => {
	console.error("[agreement] FATAL:", err);
	process.exit(1);
});
