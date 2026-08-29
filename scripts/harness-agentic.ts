#!/usr/bin/env bun
/**
 * harness-agentic - the benchmark shape where a harness lever can actually show.
 *
 * The single-turn set is at ceiling: ornith-1.0-9b scores 11/11 including
 * multi-hop, contradiction detection and absence detection. Both levers measured
 * so far came back delta zero, and the reason is the same in every case - if the
 * answer is already in the window, no amount of harness helps.
 *
 * So here the answer is NEVER in the window. The model starts with a question
 * and a tool menu, and has to find its own material across several steps. That
 * is where retrieval choice, step discipline and context economy start to
 * matter, which is where the levers live.
 *
 *   bun scripts/harness-agentic.ts --base URL --model M
 *
 * Two arms, same tasks, same tools:
 *
 *   ACCUMULATE  every step appends to one growing conversation. What a naive
 *               agent loop does, and what filled a real 256k window mid-debug.
 *   SELFBRIEF   each step is a fresh call carrying only the question and a
 *               running set of findings the model itself wrote. The transcript
 *               is discarded.
 *
 * Scoring stays deterministic: every task's ground truth was grepped out of the
 * repo, so a pass means the model reproduced something that exists on disk.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const arg = (f: string, d: string) => {
	const i = process.argv.indexOf(f);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg("--base", "http://127.0.0.1:1234").replace(/\/+$/, "");
const MODEL = arg("--model", "");
const TIMEOUT = Number(arg("--timeout", "180000"));
const MAX_STEPS = Number(arg("--steps", "5"));
const ROOT = join(import.meta.dir, "..");

/** The searchable surface. Bounded so a run is affordable on CPU. */
const SEARCH_DIRS = ["packages/eight", "packages/eight/clients", "packages/providers"];

interface Task {
	id: string;
	ask: string;
	truth: string[];
	provenance: string;
}

const TASKS: Task[] = [
	{
		id: "find-turn-timeout",
		ask: "Find the default per-attempt turn timeout used by the agent. Give the numeric value in milliseconds and the filename that defines it.",
		truth: ["300000", "turn-timeout"],
		provenance: "packages/eight/turn-timeout.ts:31 DEFAULT_TURN_TIMEOUT_MS = 300_000",
	},
	{
		id: "find-lmstudio-budget",
		ask: "Find the default output token budget the LM Studio client sends, and the environment variable that overrides it.",
		truth: ["4000", "LM_STUDIO_MAX_TOKENS"],
		provenance: "packages/eight/clients/lmstudio.ts:26",
	},
	{
		id: "compare-local-ports",
		ask: "Two local model clients each have a default base URL. Find both and report which port each defaults to.",
		truth: ["1234", "11434"],
		provenance: "lmstudio.ts:24 localhost:1234; ollama.ts:27 localhost:11434. Requires finding two files unaided.",
	},
];

// ---- the tools, in shorthand. Terse on purpose: fewer tokens to emit and
// fewer ways to malform than a JSON tool call.
const listing = () => {
	const out: string[] = [];
	for (const d of SEARCH_DIRS) {
		try {
			for (const f of readdirSync(join(ROOT, d))) {
				const p = join(ROOT, d, f);
				try {
					if (statSync(p).isFile() && f.endsWith(".ts") && !f.includes(".test."))
						out.push(relative(ROOT, p));
				} catch {}
			}
		} catch {}
	}
	return [...new Set(out)].sort();
};

const FILES = listing();

function grep(pattern: string): string {
	const hits: string[] = [];
	let re: RegExp;
	try {
		re = new RegExp(pattern, "i");
	} catch {
		return "bad pattern";
	}
	for (const f of FILES) {
		let body = "";
		try {
			body = readFileSync(join(ROOT, f), "utf8");
		} catch {
			continue;
		}
		body.split("\n").forEach((line, i) => {
			if (hits.length < 25 && re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
		});
	}
	return hits.length ? hits.join("\n") : "no matches";
}

function readFile(p: string): string {
	const clean = p.replace(/^[./]+/, "").replace(/[`'"]/g, "");
	if (!FILES.includes(clean)) return `not in scope. available files:\n${FILES.join("\n")}`;
	const body = readFileSync(join(ROOT, clean), "utf8").split("\n").slice(0, 120).join("\n");
	return `--- ${clean} (first 120 lines) ---\n${body}`;
}

/** Execute one shorthand op. Returns null when the line is not an op. */
function exec(line: string): string | null {
	const t = line.trim();
	let m = t.match(/^>?\s*ls\b/i);
	if (m) return FILES.join("\n");
	m = t.match(/^>?\s*grep\s+(.+)$/i);
	if (m) return grep(m[1].trim().replace(/^["']|["']$/g, ""));
	m = t.match(/^>?\s*read\s+(\S+)/i);
	if (m) return readFile(m[1]);
	return null;
}

const MENU =
	`Tools, one per reply, nothing else on the line:\n` +
	`  >ls              list files you may read\n` +
	`  >grep <regex>    search all files, returns path:line: text\n` +
	`  >read <path>     read a file\n` +
	`  >answer <text>   give the final answer and stop\n`;

async function llm(messages: { role: string; content: string }[], maxTokens = 2000) {
	const res = await fetch(`${BASE}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, stream: false }),
		signal: AbortSignal.timeout(TIMEOUT),
	});
	const j: any = await res.json().catch(() => null);
	const m = j?.choices?.[0]?.message ?? {};
	const c = typeof m.content === "string" ? m.content : "";
	const r = typeof m.reasoning_content === "string" ? m.reasoning_content : "";
	return (c.trim() || r.trim());
}

const finalOf = (s: string) => {
	const m = s.match(/>?\s*answer\s+([\s\S]+)/i);
	return m ? m[1].trim() : null;
};

/** ACCUMULATE: one conversation, every observation appended. */
async function accumulate(task: Task) {
	const msgs = [
		{ role: "user", content: `${MENU}\nTask: ${task.ask}\n\nReply with ONE tool line.` },
	];
	let chars = 0;
	for (let step = 0; step < MAX_STEPS; step++) {
		const out = await llm(msgs);
		const fin = finalOf(out);
		if (fin) return { answer: fin, steps: step + 1, chars };
		const obs = exec(out);
		msgs.push({ role: "assistant", content: out });
		msgs.push({
			role: "user",
			content: obs === null ? "Not a tool line. Reply with ONE tool line." : `${obs}\n\nReply with ONE tool line.`,
		});
		chars = msgs.reduce((n, m) => n + m.content.length, 0);
	}
	const last = await llm([...msgs, { role: "user", content: "Now use >answer to give your final answer." }]);
	return { answer: finalOf(last) ?? last, steps: MAX_STEPS, chars };
}

/**
 * SELFBRIEF: every step is a fresh call. The only thing that survives is a
 * findings list the model wrote itself, so the transcript never accumulates.
 */
async function selfbrief(task: Task) {
	const findings: string[] = [];
	let peak = 0;
	for (let step = 0; step < MAX_STEPS; step++) {
		const ctx =
			`${MENU}\nTask: ${task.ask}\n\n` +
			(findings.length ? `What you have established so far:\n${findings.map((f) => `- ${f}`).join("\n")}\n\n` : "") +
			`Reply with ONE tool line. Use >answer only when the findings above are enough.`;
		peak = Math.max(peak, ctx.length);
		const out = await llm([{ role: "user", content: ctx }]);
		const fin = finalOf(out);
		if (fin) return { answer: fin, steps: step + 1, chars: peak };
		const obs = exec(out);
		if (obs === null) {
			findings.push(`(a malformed tool line was ignored)`);
			continue;
		}
		// The model compresses the observation itself. This is the lever: the raw
		// output is thrown away and only the model's own note survives.
		const note = await llm(
			[
				{
					role: "user",
					content:
						`Task: ${task.ask}\n\nYou ran: ${out.trim().slice(0, 80)}\nResult:\n${obs.slice(0, 6000)}\n\n` +
						`In ONE short sentence, state only what this establishes for the task. ` +
						`If it establishes nothing, say "nothing useful".`,
				},
			],
			400,
		);
		findings.push(note.replace(/\s+/g, " ").slice(0, 200));
	}
	const ctx =
		`Task: ${task.ask}\n\nEstablished:\n${findings.map((f) => `- ${f}`).join("\n")}\n\nGive the final answer.`;
	peak = Math.max(peak, ctx.length);
	return { answer: await llm([{ role: "user", content: ctx }]), steps: MAX_STEPS, chars: peak };
}

const norm = (s: string) => s.toLowerCase().replace(/[,_](?=\d)/g, "").replace(/\s+/g, " ");
const scores = (ans: string, t: Task) => t.truth.every((v) => norm(ans).includes(norm(v)));

console.log(`harness-agentic  ${BASE}  ${MODEL}  ${FILES.length} files in scope, max ${MAX_STEPS} steps`);
console.log("the answer is never in the window; the model must find it");
console.log("=".repeat(76));

let aPass = 0;
let sPass = 0;
let aChars = 0;
let sChars = 0;

for (const t of TASKS) {
	const a = await accumulate(t);
	const aOk = scores(a.answer, t);
	if (aOk) aPass++;
	aChars += a.chars;

	const s = await selfbrief(t);
	const sOk = scores(s.answer, t);
	if (sOk) sPass++;
	sChars += s.chars;

	console.log(`\n${t.id}`);
	console.log(`  ACCUMULATE ${aOk ? "PASS" : "FAIL"}  ${a.steps} steps  ${a.chars} chars peak  -> ${JSON.stringify(a.answer.replace(/\s+/g, " ").slice(0, 80))}`);
	console.log(`  SELFBRIEF  ${sOk ? "PASS" : "FAIL"}  ${s.steps} steps  ${s.chars} chars peak  -> ${JSON.stringify(s.answer.replace(/\s+/g, " ").slice(0, 80))}`);
}

const n = TASKS.length;
console.log(`\n${"=".repeat(76)}`);
console.log(`ACCUMULATE  ${aPass}/${n}   ${Math.round(aChars / n)} chars peak context per task`);
console.log(`SELFBRIEF   ${sPass}/${n}   ${Math.round(sChars / n)} chars peak context per task`);
console.log(`\ndelta ${sPass - aPass >= 0 ? "+" : ""}${sPass - aPass} of ${n}`);
console.log(`${n} tasks is a signal, not a proof. Ground truth is grepped from real files.`);
