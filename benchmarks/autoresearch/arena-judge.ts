#!/usr/bin/env bun
/**
 * arena-judge.ts - impartial scoring for the AutoResearch head-to-head.
 *
 * Reads the two entries for a round (8gent ensemble vs Claude), sends them
 * blind to Gemini Flash via OpenRouter, and writes a verdict. The judge is
 * never told which entry is which.
 *
 *   ARENA_ROUND=round-4 bun run benchmarks/autoresearch/arena-judge.ts
 *
 * Output: benchmarks/autoresearch/arena/<round>/verdict.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROUND = process.env.ARENA_ROUND ?? "round-4";
const ARENA = join(import.meta.dir, "arena", ROUND);
const JUDGE_MODEL = "google/gemini-2.5-flash";

const TASK = `Build a single-file animated 3D portfolio hero (index.html) with a
full-viewport Three.js scene, an animated mouse-reactive 3D centerpiece, tasteful
lighting, a dark theme with no purple/pink, an overlaid name headline + subtitle +
CTA, responsiveness, and a clean requestAnimationFrame loop with cleanup.`;

function readEntry(side: string): string {
	try {
		return readFileSync(join(ARENA, side, "index.html"), "utf-8");
	} catch {
		return "";
	}
}

function apiKey(): string {
	const env = process.env.OPENROUTER_API_KEY;
	if (env) return env;
	try {
		const dotenv = readFileSync(join(import.meta.dir, "..", "..", ".env"), "utf-8");
		const m = dotenv.match(/^OPENROUTER_API_KEY=(.+)$/m);
		if (m) return m[1].trim().replace(/^["']|["']$/g, "");
	} catch {
		/* fall through */
	}
	throw new Error("OPENROUTER_API_KEY not found in env or .env");
}

async function main(): Promise<void> {
	const entry8gent = readEntry("8gent");
	const entryClaude = readEntry("claude");
	if (!entry8gent || !entryClaude) {
		console.error(`Missing entry - 8gent:${entry8gent.length}ch claude:${entryClaude.length}ch`);
		process.exit(1);
	}

	// Blind: A and B are assigned but the judge is not told the mapping.
	const prompt = `You are an impartial code judge. Two anonymous entries, A and B, were each
asked to build the SAME deliverable:

TASK: ${TASK}

Score EACH entry 0-10 on every criterion:
- correctness: does it fulfil the task, is the code valid and runnable
- efficiency: minimal, no unnecessary complexity, performant
- code_quality: clean, readable, idiomatic, well-structured
- resourcefulness: good use of Three.js, thoughtful details, polish

Return ONLY minified JSON, no prose, this exact shape:
{"A":{"correctness":N,"efficiency":N,"code_quality":N,"resourcefulness":N,"total":N,"notes":"one sentence"},
"B":{"correctness":N,"efficiency":N,"code_quality":N,"resourcefulness":N,"total":N,"notes":"one sentence"},
"winner":"A"|"B"|"tie","reasoning":"two sentences"}
"total" is the sum of the four criteria (max 40).

ENTRY A:
${entry8gent}

ENTRY B:
${entryClaude}`;

	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey()}`,
		},
		body: JSON.stringify({
			model: JUDGE_MODEL,
			messages: [{ role: "user", content: prompt }],
			temperature: 0.2,
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	const raw = json.choices?.[0]?.message?.content ?? "";
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) throw new Error(`judge returned no JSON: ${raw.slice(0, 200)}`);
	const verdict = JSON.parse(match[0]) as Record<string, unknown>;

	// Map the blind A/B back to real identities.
	const result = {
		round: ROUND,
		ts: new Date().toISOString(),
		judge: JUDGE_MODEL,
		entries: { A: "8gent-ensemble", B: "claude-opus" },
		scores: { "8gent": verdict.A, claude: verdict.B },
		winner:
			verdict.winner === "A" ? "8gent" : verdict.winner === "B" ? "claude" : "tie",
		reasoning: verdict.reasoning,
	};
	writeFileSync(join(ARENA, "verdict.json"), JSON.stringify(result, null, 2));

	const a = verdict.A as { total?: number };
	const b = verdict.B as { total?: number };
	console.log(`Round ${ROUND} verdict (judge: ${JUDGE_MODEL})`);
	console.log(`  8gent ensemble : ${a?.total ?? "?"}/40`);
	console.log(`  claude opus    : ${b?.total ?? "?"}/40`);
	console.log(`  winner         : ${result.winner}`);
	console.log(`  ${result.reasoning}`);
}

main().catch((err) => {
	console.error(`JUDGE FAILED: ${err}`);
	process.exit(1);
});
