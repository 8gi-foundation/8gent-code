#!/usr/bin/env bun
/**
 * judge-abstain-bench.ts — proof for the MiniCPM5-1B gatekeeper (#2742).
 *
 * Runs a FIXED set of (artifact, isCorrect) pairs — some genuinely good
 * code/HTML, some deliberately broken/hallucinated (wrong API, truncated,
 * fabricated facts) — through the LOCAL MiniCPM5-1B judge on Ollama's
 * OpenAI-compatible endpoint (openbmb/minicpm5:latest). MiniCPM emits a
 * <think>...</think> block before its answer; we strip it before parsing.
 *
 * It measures, over the fixed set:
 *   - false-approve rate  (judge approved a BROKEN artifact — the costly error)
 *   - false-reject rate   (judge rejected a GOOD artifact)
 *   - abstain rate        (judge said UNSURE — the desired conservative behavior)
 *   - p50 / p95 latency
 * and ASSERTS zero cloud/network calls on the judge path: the only endpoint hit
 * is localhost:11434, and the flag-on kernel JudgeScorer config resolves to the
 * local Ollama URL (no OpenRouter). Any accidental cloud host aborts the run.
 *
 * The current default cloud judge (google/gemini-2.5-flash via OpenRouter) is
 * run over the SAME set ONLY when OPENROUTER_API_KEY is present; otherwise the
 * cloud comparison is clearly reported as SKIPPED (never fabricated).
 *
 * Run:  bun run benchmarks/autoresearch/judge-abstain-bench.ts
 */

import {
	JudgeScorer,
	MINICPM_MODEL,
	OLLAMA_OPENAI_URL,
	stripThink,
} from "../../packages/kernel/judge";

// ── Fixed artifact set ───────────────────────────────────────────────────────
// isCorrect=true  -> a genuinely good/valid artifact (approving it is right).
// isCorrect=false -> a broken/hallucinated artifact (approving it is a bug).

interface Artifact {
	id: string;
	task: string;
	artifact: string;
	isCorrect: boolean;
	note: string;
}

const ARTIFACTS: Artifact[] = [
	// ---- GOOD ----
	{
		id: "good-js-add",
		task: "Write a JS function that returns the sum of two numbers.",
		artifact: "function add(a, b) { return a + b; }",
		isCorrect: true,
		note: "valid JS, correct behavior",
	},
	{
		id: "good-py-factorial",
		task: "Write a correct recursive factorial in Python.",
		artifact: "def factorial(n):\n    if n <= 1:\n        return 1\n    return n * factorial(n - 1)",
		isCorrect: true,
		note: "valid, has base case",
	},
	{
		id: "good-html-page",
		task: "Write a minimal valid HTML5 page with a heading.",
		artifact: '<!doctype html><html><head><meta charset="utf-8"><title>Hi</title></head><body><h1>Hello</h1></body></html>',
		isCorrect: true,
		note: "well-formed, closed tags",
	},
	{
		id: "good-fetch-json",
		task: "Fetch JSON from a URL in JS and parse the body.",
		artifact: "const res = await fetch(url);\nconst data = await res.json();",
		isCorrect: true,
		note: "correct fetch/json API",
	},
	{
		id: "good-array-reverse",
		task: "Reverse an array in JS without mutating the original.",
		artifact: "const reversed = [...arr].reverse();",
		isCorrect: true,
		note: "correct, non-mutating",
	},
	{
		id: "good-css-center",
		task: "Center a child in a flex container with CSS.",
		artifact: ".parent { display: flex; align-items: center; justify-content: center; }",
		isCorrect: true,
		note: "valid CSS, correct properties",
	},
	{
		id: "good-sql-select",
		task: "Select active users from a users table in SQL.",
		artifact: "SELECT id, email FROM users WHERE active = true;",
		isCorrect: true,
		note: "valid SQL",
	},
	// ---- BROKEN / HALLUCINATED ----
	{
		id: "bad-js-nonexistent-api",
		task: "Flatten a nested JS array one level.",
		artifact: "const flat = arr.flatten(1);",
		isCorrect: false,
		note: "Array.prototype.flatten does not exist (it is .flat)",
	},
	{
		id: "bad-py-syntax",
		task: "Write a Python function that returns n squared.",
		artifact: "def square(n)\n    return n * n",
		isCorrect: false,
		note: "SyntaxError: missing colon after def",
	},
	{
		id: "bad-html-truncated",
		task: "Write a valid HTML5 page with a form.",
		artifact: '<!doctype html><html><head><title>Form</title></head><body><form><input name="q"',
		isCorrect: false,
		note: "truncated: unclosed tag, no closing body/html",
	},
	{
		id: "bad-fetch-hallucinated",
		task: "Fetch JSON from a URL in JS and parse the body.",
		artifact: "const res = await fetch(url);\nconst data = await res.toJSON();",
		isCorrect: false,
		note: "hallucinated API: Response has no toJSON(); should be .json()",
	},
	{
		id: "bad-fabricated-fact",
		task: "State the HTTP status code named 'I'm a teapot'.",
		artifact: "The HTTP status code for \"I'm a teapot\" is 200 OK.",
		isCorrect: false,
		note: "fabricated fact: teapot is 418, not 200",
	},
	{
		id: "bad-py-no-base-case",
		task: "Write a correct recursive factorial in Python.",
		artifact: "def factorial(n):\n    return n * factorial(n - 1)",
		isCorrect: false,
		note: "infinite recursion: no base case",
	},
	{
		id: "bad-react-undefined",
		task: "Write a React counter component that renders a count.",
		artifact: "function Counter() {\n  const [c, setC] = useState(0);\n}",
		isCorrect: false,
		note: "no import of useState, returns undefined (renders nothing)",
	},
];

// ── Judge decision types ─────────────────────────────────────────────────────
type Decision = "approve" | "reject" | "abstain" | "parse_error";

const JUDGE_SYSTEM = `You are a strict gatekeeper for an autonomous coding agent.
You are given a TASK and an ARTIFACT the agent produced. Decide if the artifact
CORRECTLY and SAFELY fulfills the task with no bugs, no invalid syntax, no
hallucinated/nonexistent APIs, and no fabricated facts.

Rules:
- If it is clearly correct, verdict "approve".
- If it is clearly broken, invalid, hallucinated, or factually wrong, verdict "reject".
- If you genuinely cannot tell, verdict "unsure". Do NOT guess.

Return ONLY a JSON object on one line, no prose after it:
{"verdict":"approve|reject|unsure","reason":"<one short sentence>"}`;

function classifyVerdict(text: string): Decision {
	const clean = stripThink(text);
	// Try JSON first.
	const start = clean.indexOf("{");
	const end = clean.lastIndexOf("}");
	let verdict = "";
	if (start !== -1 && end > start) {
		try {
			const obj = JSON.parse(clean.slice(start, end + 1));
			verdict = String(obj.verdict ?? "").toLowerCase();
		} catch {
			/* fall through to keyword scan */
		}
	}
	const hay = (verdict || clean).toLowerCase();
	// Abstain synonyms first (conservative): unsure/uncertain/cannot tell.
	if (/\b(unsure|uncertain|cannot tell|can't tell|not sure|abstain|unknown)\b/.test(hay)) {
		return "abstain";
	}
	if (/\b(reject|invalid|incorrect|broken|wrong|false|bad|no)\b/.test(hay)) return "reject";
	if (/\b(approve|valid|correct|good|yes|ok|pass)\b/.test(hay)) return "approve";
	return verdict ? "parse_error" : "abstain"; // no signal -> treat as abstain (conservative)
}

interface Result {
	id: string;
	isCorrect: boolean;
	decision: Decision;
	latencyMs: number;
	truncated: boolean; // hit the token cap inside <think> before emitting a verdict
	raw: string;
}

const MAX_TOKENS = 2048;

async function judgeLocal(a: Artifact): Promise<Result> {
	const t0 = performance.now();
	const res = await fetch(`${OLLAMA_OPENAI_URL}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer ollama" },
		body: JSON.stringify({
			model: MINICPM_MODEL,
			messages: [
				{ role: "system", content: JUDGE_SYSTEM },
				{ role: "user", content: `TASK:\n${a.task}\n\nARTIFACT:\n${a.artifact}` },
			],
			temperature: 0,
			max_tokens: MAX_TOKENS,
		}),
	});
	const latencyMs = performance.now() - t0;
	if (!res.ok) {
		return { id: a.id, isCorrect: a.isCorrect, decision: "parse_error", latencyMs, truncated: false, raw: `HTTP ${res.status}` };
	}
	const data = (await res.json()) as {
		choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
	};
	const raw = data.choices?.[0]?.message?.content ?? "";
	const decision = classifyVerdict(raw);
	// A "length" finish with no parseable verdict = the 1B over-thought and ran
	// out of budget. We still count it as abstain (conservative: escalate), but
	// flag it so the abstain number is not mistaken for pure confident "unsure".
	const truncated = data.choices?.[0]?.finish_reason === "length" && decision === "abstain";
	return { id: a.id, isCorrect: a.isCorrect, decision, latencyMs, truncated, raw };
}

function p(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
	return sorted[idx] ?? 0;
}

function pct(n: number, d: number): string {
	return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

async function main() {
	console.log("=".repeat(72));
	console.log("MiniCPM5-1B judge-abstain bench (#2742)");
	console.log(`Model: ${MINICPM_MODEL}  Endpoint: ${OLLAMA_OPENAI_URL}`);
	console.log("=".repeat(72));

	// ── Assert the judge path is LOCAL (no cloud egress) ──────────────────────
	if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(OLLAMA_OPENAI_URL)) {
		throw new Error(`ABORT: judge endpoint is not local: ${OLLAMA_OPENAI_URL}`);
	}
	// Prove the real kernel wiring (flag on) resolves to the local endpoint.
	process.env.EIGHT_JUDGE_MINICPM = "1";
	const wired = new JudgeScorer();
	const cfg = (wired as unknown as { config: { prmUrl: string; prmModel: string } }).config;
	if (cfg.prmModel !== MINICPM_MODEL) {
		throw new Error(`ABORT: flag-on kernel judge model is ${cfg.prmModel}, expected ${MINICPM_MODEL}`);
	}
	if (/openrouter\.ai/.test(cfg.prmUrl) || !/localhost|127\.0\.0\.1/.test(cfg.prmUrl)) {
		throw new Error(`ABORT: flag-on kernel judge URL is cloud: ${cfg.prmUrl}`);
	}
	console.log(`\n[assert] flag-on kernel JudgeScorer -> model=${cfg.prmModel} url=${cfg.prmUrl}`);
	console.log(`[assert] all judge calls target ${OLLAMA_OPENAI_URL} (no OpenRouter host).\n`);

	// ── Run local MiniCPM judge over the fixed set ────────────────────────────
	const results: Result[] = [];
	for (const a of ARTIFACTS) {
		const r = await judgeLocal(a);
		results.push(r);
		const mark = r.decision === "abstain" ? "~" : (r.decision === "approve") === r.isCorrect ? "+" : "x";
		console.log(
			`  [${mark}] ${r.id.padEnd(26)} truth=${r.isCorrect ? "GOOD " : "BROKEN"}  judge=${r.decision.padEnd(11)}  ${r.latencyMs.toFixed(0)}ms`,
		);
	}

	// ── Metrics ───────────────────────────────────────────────────────────────
	const broken = results.filter((r) => !r.isCorrect);
	const good = results.filter((r) => r.isCorrect);
	const falseApprove = broken.filter((r) => r.decision === "approve").length;
	const falseReject = good.filter((r) => r.decision === "reject").length;
	const abstain = results.filter((r) => r.decision === "abstain").length;
	const truncated = results.filter((r) => r.truncated).length;
	const parseErr = results.filter((r) => r.decision === "parse_error").length;
	const lat = results.map((r) => r.latencyMs).sort((x, y) => x - y);

	console.log(`\n${"─".repeat(72)}`);
	console.log("LOCAL MiniCPM5-1B judge — metrics over", results.length, "artifacts");
	console.log("─".repeat(72));
	console.log(`  false-approve rate : ${pct(falseApprove, broken.length)}  (${falseApprove}/${broken.length} broken artifacts approved)  << the costly error`);
	console.log(`  false-reject rate  : ${pct(falseReject, good.length)}  (${falseReject}/${good.length} good artifacts rejected)`);
	console.log(`  abstain rate       : ${pct(abstain, results.length)}  (${abstain}/${results.length} said UNSURE — desired conservative behavior)`);
	console.log(`    of which truncated: ${truncated}/${abstain}  (over-thought past ${MAX_TOKENS}-tok budget, no verdict -> counted as abstain)`);
	console.log(`  parse-error rate   : ${pct(parseErr, results.length)}  (${parseErr}/${results.length} unparseable)`);
	console.log(`  latency p50 / p95  : ${p(lat, 0.5).toFixed(0)}ms / ${p(lat, 0.95).toFixed(0)}ms`);

	// ── Cloud comparison (only with a real key; never fabricated) ─────────────
	console.log(`\n${"─".repeat(72)}`);
	if (!process.env.OPENROUTER_API_KEY) {
		console.log("CLOUD COMPARISON (google/gemini-2.5-flash via OpenRouter): SKIPPED");
		console.log("  Reason: OPENROUTER_API_KEY not set in this environment.");
		console.log("  No cloud numbers are reported — the comparison was NOT run and NOT fabricated.");
	} else {
		console.log("CLOUD COMPARISON (google/gemini-2.5-flash via OpenRouter): RUNNING");
		const cloud: Result[] = [];
		for (const a of ARTIFACTS) {
			const t0 = performance.now();
			const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
				},
				body: JSON.stringify({
					model: "google/gemini-2.5-flash",
					messages: [
						{ role: "system", content: JUDGE_SYSTEM },
						{ role: "user", content: `TASK:\n${a.task}\n\nARTIFACT:\n${a.artifact}` },
					],
					temperature: 0,
					max_tokens: 300,
				}),
			});
			const latencyMs = performance.now() - t0;
			const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
			const raw = data.choices?.[0]?.message?.content ?? "";
			cloud.push({ id: a.id, isCorrect: a.isCorrect, decision: classifyVerdict(raw), latencyMs, raw });
		}
		const cBroken = cloud.filter((r) => !r.isCorrect);
		const cGood = cloud.filter((r) => r.isCorrect);
		const cFA = cBroken.filter((r) => r.decision === "approve").length;
		const cFR = cGood.filter((r) => r.decision === "reject").length;
		const cAb = cloud.filter((r) => r.decision === "abstain").length;
		const cLat = cloud.map((r) => r.latencyMs).sort((x, y) => x - y);
		console.log("\n  metric              local-minicpm     cloud-gemini-flash");
		console.log(`  false-approve rate  ${pct(falseApprove, broken.length).padEnd(16)}  ${pct(cFA, cBroken.length)}`);
		console.log(`  false-reject rate   ${pct(falseReject, good.length).padEnd(16)}  ${pct(cFR, cGood.length)}`);
		console.log(`  abstain rate        ${pct(abstain, results.length).padEnd(16)}  ${pct(cAb, cloud.length)}`);
		console.log(`  latency p50         ${(p(lat, 0.5).toFixed(0) + "ms").padEnd(16)}  ${p(cLat, 0.5).toFixed(0)}ms`);
	}

	console.log(`\n${"=".repeat(72)}`);
	console.log("DONE. Raw numbers above are the ground truth — no conclusions asserted here.");
	console.log("=".repeat(72));
}

main().catch((err) => {
	console.error("bench failed:", err);
	process.exit(1);
});
