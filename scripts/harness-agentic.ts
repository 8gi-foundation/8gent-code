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
 *
 * ## RESULT: the self-brief lever loses here, and the reason is not the data
 *
 * Two runs against ornith-1.0-9b, 6 tasks, 5 steps:
 *
 *   run 1 (summarised notes)   ACCUMULATE 5/6   SELFBRIEF 2/6
 *   run 2 (verbatim notes)     ACCUMULATE 4/6   SELFBRIEF 2/6
 *
 * The verbatim-notes fix was the obvious repair and it changed nothing, so the
 * lever is not failing for want of tuning. Run 2's failures name the real
 * cause: it answered "I cannot complete this task because you haven't provided
 * the actual grep search" one step after running that grep, and elsewhere
 * emitted a fenced `cat` command that is not in the tool menu at all.
 *
 * Resetting the window does not only discard the raw observation. It discards
 * the model's memory of WHAT IT JUST DID. A findings list carries facts; it
 * does not carry trajectory, and without trajectory the model cannot tell a
 * fresh task from one already three steps in.
 *
 * Which reconciles the two measurements that looked contradictory:
 *
 *   single-turn, material already in the window  ->  98% context shrink, 4/4
 *   agentic, model must navigate to the material ->  -2 of 6
 *
 * Compaction is free when the work is READING and expensive when the work is
 * NAVIGATING. The design that follows is compact the observations, keep the
 * trajectory - a short ordered log of actions taken alongside the compacted
 * findings. Untested, so it is written here as the next hypothesis and not as
 * a conclusion.
 *
 * The lever stays in the tree as a losing arm. Deleting it would leave the next
 * person to re-derive the same negative result, and an arm that lost is the
 * only thing that makes the arm that won mean anything.
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
const SEARCH_DIRS = [
	"packages/eight",
	"packages/eight/clients",
	"packages/eight/prompts",
	"packages/providers",
];

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

	// ---- CANARIES ---------------------------------------------------------
	// Values that exist only in this repository. No pretrained model can guess
	// them, so a pass here is evidence of retrieval rather than recall.
	//
	// This distinction was forced by the first run: on compare-local-ports the
	// model scored a PASS while answering "based on common local AI model
	// serving clients found in typical project directories" - it produced 1234
	// and 11434 from pretraining without reading anything. Ground truth a model
	// might already know cannot measure retrieval, only plausibility.
	{
		id: "canary-board-context-cap",
		ask: "There is a constant that caps how much context the board is given. Find its exact name and its numeric value.",
		truth: ["BOARD_CONTEXT_CAP", "4500"],
		provenance:
			"canary: packages/eight/prompts/system-prompt.ts:48 exports BOARD_CONTEXT_CAP = 4500. Arbitrary project-specific value, unguessable from pretraining.",
	},
	{
		id: "canary-clamp-floor",
		ask: "The voice silence learner clamps a duration between a minimum and a maximum. Find both numbers.",
		truth: ["800", "5000"],
		provenance:
			"canary: packages/eight/voice-silence-learner.ts:24 CLAMP_MIN_MS = 800 and CLAMP_MAX_MS = 5000. Two arbitrary values in one file.",
	},
	{
		id: "canary-pii-function",
		ask: "Find the function named anonymizeOutbound. Which file defines it, and what does it take as its argument?",
		truth: ["pii-gate", "messages"],
		provenance:
			"canary: packages/eight/clients/pii-gate.ts:80 export function anonymizeOutbound(messages: Message[]). Name exists nowhere outside this repo.",
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

/**
 * Accept what a model actually writes, not what the toy parser wishes it wrote.
 *
 * The first run failed a task because the model emitted
 *   >grep -r "localhost\|127\.0\.0\.1" packages/eight/clients/*.ts | head -30
 * which is correct grep by every convention it has ever seen, and the parser
 * swallowed the flags, the glob and the pipe as part of one regex. The model
 * used the tool properly; the harness was the thing that did not understand.
 *
 * A tool surface narrower than the model's habits does not measure the model,
 * it measures the surface. So: strip leading flags, drop a trailing path or
 * glob argument, drop anything piped, and unquote.
 */
export function normalisePattern(raw: string): string {
	let s = raw.trim();
	s = s.split("|").length > 1 && /\|\s*(head|tail|wc|sort|uniq|less)\b/.test(s)
		? s.slice(0, s.search(/\|\s*(head|tail|wc|sort|uniq|less)\b/))
		: s;
	// Flags, including the --flag=value form. Caught by the unit check in
	// scripts/harness-agentic.test.ts, which had --include=*.ts sail straight
	// through into the regex.
	s = s.replace(/^(-{1,2}[a-zA-Z-]+(=\S+)?\s+)+/, "").trim();
	const quoted = s.match(/^(["'])([\s\S]*?)\1/);
	if (quoted) return quoted[2];
	// Unquoted: a trailing token that looks like a path or glob is an argument,
	// not part of the pattern.
	const parts = s.split(/\s+/);
	while (parts.length > 1 && /[/*]|\.ts$|\.js$/.test(parts[parts.length - 1])) parts.pop();
	return parts.join(" ");
}

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
	if (m) return grep(normalisePattern(m[1]));
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
		//
		// The note MUST carry values verbatim. Asking for "one sentence on what this
		// establishes" scored 2/6, and canary-clamp-floor showed why: the note said
		// the file defines clamp constants and dropped 800 and 5000, so the fresh
		// window had nothing left to answer with. The single-turn version of this
		// lever asked the model to QUOTE the lines and scored 4/4. Summarising is
		// lossy exactly where the answer lives, and a compression step that
		// paraphrases the fact it was compressing is how a retrieval loop quietly
		// becomes a recall loop.
		const note = await llm(
			[
				{
					role: "user",
					content:
						`Task: ${task.ask}\n\nYou ran: ${out.trim().slice(0, 80)}\nResult:\n${obs.slice(0, 6000)}\n\n` +
						`Write a note to yourself. Copy VERBATIM every file path, identifier, ` +
						`number or literal in the result that bears on the task - exact ` +
						`characters, no rounding, no paraphrasing, do not summarise them away. ` +
						`If the result contains nothing relevant, say "nothing useful".`,
				},
			],
			600,
		);
		findings.push(note.replace(/\s+/g, " ").slice(0, 200));
	}
	const ctx =
		`Task: ${task.ask}\n\nEstablished:\n${findings.map((f) => `- ${f}`).join("\n")}\n\nGive the final answer.`;
	peak = Math.max(peak, ctx.length);
	return { answer: await llm([{ role: "user", content: ctx }]), steps: MAX_STEPS, chars: peak };
}

/**
 * TRAJECTORY: the hypothesis the other two arms point at.
 *
 * Identical to SELFBRIEF - fresh window every step, observations compacted -
 * except that a short ordered log of what was already DONE travels with the
 * findings. SELFBRIEF failed by answering "you haven't provided the actual grep
 * search" one step after running that grep: it had the facts and no idea it was
 * mid-task. Facts are not trajectory.
 *
 * If this lands between the two, the lesson is that compaction must preserve
 * the shape of the work, not only its results.
 */
async function trajectory(task: Task) {
	const actions: string[] = [];
	const findings: string[] = [];
	let peak = 0;
	for (let step = 0; step < MAX_STEPS; step++) {
		const ctx =
			`${MENU}\nTask: ${task.ask}\n\n` +
			(actions.length
				? `Steps you have already taken (${actions.length} of ${MAX_STEPS}):\n${actions.map((a, i) => `  ${i + 1}. ${a}`).join("\n")}\n\n`
				: `This is step 1. You have not run anything yet.\n\n`) +
			(findings.length ? `What you established:\n${findings.map((f) => `- ${f}`).join("\n")}\n\n` : "") +
			`Reply with ONE tool line. Do not repeat a step you already took. ` +
			`Use >answer only when the findings above are enough.`;
		peak = Math.max(peak, ctx.length);
		const out = await llm([{ role: "user", content: ctx }]);
		const fin = finalOf(out);
		if (fin) return { answer: fin, steps: step + 1, chars: peak };
		const obs = exec(out);
		if (obs === null) {
			actions.push(`${out.trim().slice(0, 60)} -> not a valid tool line`);
			continue;
		}
		const note = await llm(
			[
				{
					role: "user",
					content:
						`Task: ${task.ask}\n\nYou ran: ${out.trim().slice(0, 80)}\nResult:\n${obs.slice(0, 6000)}\n\n` +
						`Write a note to yourself. Copy VERBATIM every file path, identifier, ` +
						`number or literal in the result that bears on the task - exact ` +
						`characters, no rounding, no paraphrasing. If nothing is relevant, say "nothing useful".`,
				},
			],
			600,
		);
		actions.push(out.trim().replace(/\s+/g, " ").slice(0, 70));
		findings.push(note.replace(/\s+/g, " ").slice(0, 200));
	}
	const ctx =
		`Task: ${task.ask}\n\nSteps taken:\n${actions.map((a, i) => `  ${i + 1}. ${a}`).join("\n")}\n\n` +
		`Established:\n${findings.map((f) => `- ${f}`).join("\n")}\n\nGive the final answer.`;
	peak = Math.max(peak, ctx.length);
	return { answer: await llm([{ role: "user", content: ctx }]), steps: MAX_STEPS, chars: peak };
}

const norm = (s: string) => s.toLowerCase().replace(/[,_](?=\d)/g, "").replace(/\s+/g, " ");
const scores = (ans: string, t: Task) => t.truth.every((v) => norm(ans).includes(norm(v)));

// Only run the benchmark when invoked directly. Without this an import
// for testing would fire the whole suite at the model.
if (import.meta.main) {
	console.log(`harness-agentic  ${BASE}  ${MODEL}  ${FILES.length} files in scope, max ${MAX_STEPS} steps`);
	console.log("the answer is never in the window; the model must find it");
	console.log("=".repeat(76));

	let aPass = 0;
	let sPass = 0;
	let tPass = 0;
	let aChars = 0;
	let sChars = 0;
	let tChars = 0;

	for (const t of TASKS) {
		const a = await accumulate(t);
		const aOk = scores(a.answer, t);
		if (aOk) aPass++;
		aChars += a.chars;

		const s = await selfbrief(t);
		const sOk = scores(s.answer, t);
		if (sOk) sPass++;
		sChars += s.chars;

		const tr = await trajectory(t);
		const tOk = scores(tr.answer, t);
		if (tOk) tPass++;
		tChars += tr.chars;

		console.log(`\n${t.id}`);
		console.log(`  ACCUMULATE ${aOk ? "PASS" : "FAIL"}  ${a.steps} steps  ${a.chars} chars peak  -> ${JSON.stringify(a.answer.replace(/\s+/g, " ").slice(0, 80))}`);
		console.log(`  SELFBRIEF  ${sOk ? "PASS" : "FAIL"}  ${s.steps} steps  ${s.chars} chars peak  -> ${JSON.stringify(s.answer.replace(/\s+/g, " ").slice(0, 80))}`);
		console.log(`  TRAJECTORY ${tOk ? "PASS" : "FAIL"}  ${tr.steps} steps  ${tr.chars} chars peak  -> ${JSON.stringify(tr.answer.replace(/\s+/g, " ").slice(0, 80))}`);
	}

	const n = TASKS.length;
	console.log(`\n${"=".repeat(76)}`);
	console.log(`ACCUMULATE  ${aPass}/${n}   ${Math.round(aChars / n)} chars peak context per task`);
	console.log(`SELFBRIEF   ${sPass}/${n}   ${Math.round(sChars / n)} chars peak context per task`);
	console.log(`TRAJECTORY  ${tPass}/${n}   ${Math.round(tChars / n)} chars peak context per task`);
	console.log(`\nselfbrief vs accumulate  ${sPass - aPass >= 0 ? "+" : ""}${sPass - aPass} of ${n}`);
	console.log(`trajectory vs accumulate ${tPass - aPass >= 0 ? "+" : ""}${tPass - aPass} of ${n}`);
	console.log(`trajectory vs selfbrief  ${tPass - sPass >= 0 ? "+" : ""}${tPass - sPass} of ${n}   <- does keeping the trajectory recover the loss?`);
	console.log(`${n} tasks is a signal, not a proof. Ground truth is grepped from real files.`);

}
