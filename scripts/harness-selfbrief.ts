#!/usr/bin/env bun
/**
 * harness-selfbrief - measure self-directed context compaction.
 *
 * James's design, tested rather than assumed:
 *
 *   1. the model asks for what it needs in SHORTHAND, not verbose tool JSON
 *   2. the harness executes those asks and hands back only the results
 *   3. the model writes its own minimal brief - the prompt it wishes it had
 *   4. the context is RESET, discarding every intermediate turn
 *   5. a fresh window answers the self-written brief
 *
 * The claim: a 9B degrades as context fills with retrieval mess, so letting it
 * author a clean prompt and then throwing the mess away buys accuracy that no
 * amount of extra tokens per second would.
 *
 * Measured against the accumulate-everything baseline every harness starts
 * with: stuff the files in, ask the question, hope.
 *
 *   bun scripts/harness-selfbrief.ts --base URL --model M
 *
 * Ground truth is grepped out of real files in this repo, so a pass means the
 * model reproduced a fact that exists on disk, not a plausible-looking one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const arg = (f: string, d: string) => {
	const i = process.argv.indexOf(f);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg("--base", "http://127.0.0.1:1234").replace(/\/+$/, "");
const MODEL = arg("--model", "");
const TIMEOUT = Number(arg("--timeout", "180000"));
const ROOT = join(import.meta.dir, "..");

/** The corpus the model may retrieve from. Real files, real sizes. */
const CORPUS = [
	"packages/eight/turn-timeout.ts",
	"packages/eight/clients/lmstudio.ts",
	"packages/eight/clients/ollama.ts",
];

interface Q {
	ask: string;
	/** Accept any of these as correct; grepped from the files above. */
	accept: string[];
	/** Which file actually holds the answer, for scoring retrieval choice. */
	inFile: string;
}

const QUESTIONS: Q[] = [
	{
		ask: "What is the default per-attempt turn timeout in milliseconds?",
		accept: ["300000", "300_000", "300 000"],
		inFile: "packages/eight/turn-timeout.ts",
	},
	{
		ask: "What is the minimum allowed turn timeout in milliseconds?",
		accept: ["1000", "1_000"],
		inFile: "packages/eight/turn-timeout.ts",
	},
	{
		ask: "What is the default max_tokens the LM Studio client sends?",
		accept: ["4000"],
		inFile: "packages/eight/clients/lmstudio.ts",
	},
	{
		ask: "Which environment variable overrides the LM Studio token budget?",
		accept: ["LM_STUDIO_MAX_TOKENS"],
		inFile: "packages/eight/clients/lmstudio.ts",
	},
];

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

async function ask(messages: { role: string; content: string }[], maxTokens = 3000) {
	const res = await fetch(`${BASE}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, stream: false }),
		signal: AbortSignal.timeout(TIMEOUT),
	});
	const j: any = await res.json().catch(() => null);
	const m = j?.choices?.[0]?.message ?? {};
	const content = typeof m.content === "string" ? m.content : "";
	const reasoning = typeof m.reasoning_content === "string" ? m.reasoning_content : "";
	// Reasoning models put the answer in reasoning_content when content is
	// empty. Measured on ornith-1.0-9b; reading only content scores a working
	// model as a total failure.
	return (content.trim() || reasoning.trim());
}

const correct = (out: string, q: Q) => q.accept.some((a) => out.includes(a));

/** BASELINE: every file in the window, then the question. What harnesses do by default. */
async function baseline(q: Q) {
	const dump = CORPUS.map((p) => `--- ${p} ---\n${read(p)}`).join("\n\n");
	const out = await ask([
		{ role: "user", content: `${dump}\n\nQuestion: ${q.ask}\nAnswer with the value only.` },
	]);
	return { out, chars: dump.length };
}

/**
 * LEVERED: shorthand ask -> execute -> self-brief -> RESET -> answer.
 * Each step is a separate, small call. Nothing accumulates.
 */
async function selfbrief(q: Q) {
	// 1. shorthand retrieval. Terse on purpose: fewer tokens to emit, fewer
	//    ways to malform than a JSON tool call.
	const menu = CORPUS.map((p) => `  ${p}`).join("\n");
	const pick = await ask(
		[
			{
				role: "user",
				content:
					`Files available:\n${menu}\n\n` +
					`Question: ${q.ask}\n\n` +
					`Reply with ONE line, nothing else, in the form:\n>read <path>\n` +
					`Choose the single file most likely to contain the answer.`,
			},
		],
		800,
	);
	const m = pick.match(/>?\s*read\s+(\S+)/i);
	const chosen = m ? m[1].replace(/[`'"]/g, "") : "";
	const valid = CORPUS.includes(chosen);
	if (!valid) return { out: "", chars: 0, chosen, brief: "", retrievalOk: false };

	// 2. execute the ask. The harness does this, not the model.
	const body = read(chosen);

	// 3. the model writes the prompt it wishes it had: only what answers the
	//    question, nothing else.
	const brief = await ask(
		[
			{
				role: "user",
				content:
					`--- ${chosen} ---\n${body}\n\n` +
					`Question: ${q.ask}\n\n` +
					`Do NOT answer yet. Write a short brief for yourself: quote ONLY the ` +
					`lines from the file that answer the question, then restate the ` +
					`question. Under 200 words.`,
			},
		],
		1500,
	);

	// 4. RESET. Everything above is discarded; the fresh window sees only the
	//    brief the model wrote for itself.
	const out = await ask([
		{ role: "user", content: `${brief}\n\nAnswer with the value only.` },
	]);
	return { out, chars: brief.length, chosen, brief, retrievalOk: true };
}

console.log(`harness-selfbrief  ${BASE}  ${MODEL}`);
console.log("lever: shorthand retrieval -> self-written brief -> context reset");
console.log("=".repeat(74));

let bPass = 0;
let lPass = 0;
let bChars = 0;
let lChars = 0;

for (const q of QUESTIONS) {
	const b = await baseline(q);
	const bOk = correct(b.out, q);
	if (bOk) bPass++;
	bChars += b.chars;

	const l = await selfbrief(q);
	const lOk = l.retrievalOk && correct(l.out, q);
	if (lOk) lPass++;
	lChars += l.chars;

	console.log(`\n${q.ask}`);
	console.log(`  BASELINE  ${bOk ? "PASS" : "FAIL"}  ${b.chars} chars in window  -> ${JSON.stringify(b.out.slice(0, 70))}`);
	console.log(
		`  SELFBRIEF ${lOk ? "PASS" : "FAIL"}  ${l.chars} chars in window  ` +
			`retrieved ${l.chosen || "(invalid)"}${l.chosen === q.inFile ? " (right file)" : l.chosen ? " (WRONG file)" : ""}` +
			`  -> ${JSON.stringify(l.out.slice(0, 70))}`,
	);
}

const n = QUESTIONS.length;
console.log(`\n${"=".repeat(74)}`);
console.log(`BASELINE   ${bPass}/${n} correct   ${Math.round(bChars / n)} chars per question in window`);
console.log(`SELFBRIEF  ${lPass}/${n} correct   ${Math.round(lChars / n)} chars per question in window`);
const delta = lPass - bPass;
const shrink = bChars > 0 ? (1 - lChars / bChars) * 100 : 0;
console.log(`\ndelta: ${delta >= 0 ? "+" : ""}${delta} of ${n}   context shrink: ${shrink.toFixed(0)}%`);
console.log(
	delta > 0
		? "Self-brief bought accuracy at a fraction of the context."
		: delta === 0
			? "Same accuracy. The win, if any, is the context shrink - which is what buys headroom later."
			: "Self-brief LOST accuracy. The reset is dropping something the answer needed.",
);
console.log(`\n${n} questions is a signal, not a proof. Ground truth is grepped from real files.`);
