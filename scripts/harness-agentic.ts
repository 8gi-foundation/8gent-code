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
 *
 * ## THE TRAJECTORY ARM, AND THE RESULT THAT CHANGES THE THESIS
 *
 * The prediction was written into the commit before the run: if
 * facts-without-trajectory was the defect, TRAJECTORY should recover most of
 * the gap; if it landed at SELFBRIEF's score instead, the compact-and-reset
 * direction is wrong for navigation work rather than mis-implemented.
 *
 *   ACCUMULATE  5/6   7,460 chars peak
 *   SELFBRIEF   1/6   1,051 chars peak
 *   TRAJECTORY  0/6   1,197 chars peak
 *
 * It landed BELOW selfbrief. Adding the missing information made it worse.
 *
 * The failure text is the explanation: the model replied "(not yet used, should
 * use when I have enough info) Since I don't see clear grep..." - echoing the
 * scaffold back instead of acting on it. TRAJECTORY's prompt carries a menu, an
 * ordered action log, a findings list and an instruction not to repeat steps.
 * Every one of those is reasonable and together they are more instruction than
 * the task itself.
 *
 * So the conclusion is not about trajectory at all:
 *
 *   FOR A SMALL MODEL, HARNESS SCAFFOLDING IS NOT FREE. Every structure added
 *   to the prompt competes with the task for the same limited capacity, and
 *   past some point the model spends itself parsing the harness instead of
 *   doing the work.
 *
 * Which is why ACCUMULATE keeps winning. It is not a clever design; it is the
 * least instruction per step. The model continues a conversation, which is the
 * thing it is best at, and nothing asks it to also maintain a state machine.
 *
 * It reconciles every measurement taken:
 *
 *   single-turn, material in window   compaction free   4/4, 98% shrink
 *   agentic + selfbrief               scaffold competes 1-2/6
 *   agentic + trajectory              more scaffold     0/6
 *   agentic + accumulate              least scaffold    4-5/6
 *
 * The thesis "make the model smarter through the harness" survives, but with a
 * hard qualifier discovered rather than assumed: the harness only adds
 * capability while it is SIMPLER than the task it is helping with. Structure
 * that a frontier model absorbs for free is a tax a 9B pays in accuracy.
 *
 * ## CORRECTION: it is not the amount of instruction
 *
 * The paragraph above was written after TRAJECTORY scored 0/6, and its
 * mechanism was wrong. The falsification test was MINIMAL - identical protocol
 * to ACCUMULATE but with the tool menu stated once instead of a "Reply with ONE
 * tool line" reminder appended after every observation. Strictly less
 * instruction. Prediction was committed before the run: MINIMAL >= ACCUMULATE
 * if the least-instruction reading holds.
 *
 *   ACCUMULATE  5/6
 *   MINIMAL     5/6      delta +0
 *
 * Removing the repeated instruction changed nothing. So instruction VOLUME is
 * not the variable. Sort the four arms by what actually predicts the score:
 *
 *   CONTINUES A CONVERSATION           accumulate 5/6, minimal 5/6
 *   RECONSTRUCTS STATE EACH STEP       selfbrief 1-2/6, trajectory 0/6
 *
 * Instruction volume varies widely WITHIN each group and does not move the
 * result. What separates the groups is whether the model is continuing one
 * coherent exchange or rebuilding its situation from a summary every step.
 *
 * The corrected rule:
 *
 *   A small model performs when the interaction stays a continuous
 *   conversation, and degrades when each step is a fresh reconstruction -
 *   however much or little instruction accompanies that reconstruction.
 *
 * This matters for design because it points somewhere different. "Use less
 * scaffolding" would have had us trimming prompts. The real constraint is that
 * compaction must never break continuity: compact by DROPPING OLD TURNS from a
 * conversation that continues, never by rebuilding a fresh prompt from notes.
 * Same token saving, opposite outcome, and the difference is invisible in a
 * context-size metric.
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
 * The largest single tool result this environment can return. Used to reject a
 * sliding-window budget that could never hold one observation - see sliding().
 */
const LARGEST_OBSERVATION = Math.max(
	FILES.join("\n").length,
	...FILES.map((f) => {
		try {
			return readFileSync(join(ROOT, f), "utf8").split("\n").slice(0, 120).join("\n").length;
		} catch {
			return 0;
		}
	}),
);

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
			if (hits.length < GREP_HITS && re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
		});
	}
	return hits.length ? hits.join("\n") : "no matches";
}

/**
 * TERSE mode: shrink the OBSERVATIONS instead of the history.
 *
 * The sliding-window arm proved history management is a dead end here. The
 * floor - one observation - is 5,297 chars against ACCUMULATE's natural peak of
 * 6,653, so the entire range available to any windowing scheme is about 11%.
 * You cannot compress a conversation below one observation, and one observation
 * is nearly the whole conversation.
 *
 * So this is the lever that is actually left: return less per call. Paginated
 * reads, capped grep results, line ranges instead of whole files. If accuracy
 * holds while observations shrink, agentic context economy is real - it just
 * lives in the tool layer, which is kiln's side of the boundary rather than the
 * agent loop's.
 */
const TERSE = process.argv.includes("--terse");
const READ_LINES = TERSE ? 40 : 120;
const GREP_HITS = TERSE ? 8 : 25;

function readFile(p: string): string {
	const clean = p.replace(/^[./]+/, "").replace(/[`'"]/g, "");
	if (!FILES.includes(clean))
		return TERSE
			? `not in scope. ${FILES.length} files available; use >grep to find one.`
			: `not in scope. available files:\n${FILES.join("\n")}`;
	const body = readFileSync(join(ROOT, clean), "utf8").split("\n").slice(0, READ_LINES).join("\n");
	return `--- ${clean} (first ${READ_LINES} lines) ---\n${body}`;
}

/**
 * >consts - list declared constants across the searchable files.
 *
 * The one failure that survived every context change was canary-board-context-cap:
 * asked to find "a constant that caps how much context the board is given",
 * ornith-1.0-9b greps for the CONCEPT - context.*window, knownContextWindow -
 * and never finds BOARD_CONTEXT_CAP. It is reasoning about what the thing might
 * be called instead of enumerating what exists.
 *
 * Tonight's result says the lever lives in the tool layer, so this tests that
 * claim on a failure it did not come from: give the model a tool shaped like the
 * question. "Find a constant" is answerable by listing constants, and no amount
 * of cleverer grepping substitutes for a tool that matches the task shape.
 *
 * Prediction, committed before the run: with >consts available,
 * canary-board-context-cap passes. If it still fails, the defect is that the
 * model does not RECOGNISE which tool fits, and the tool surface is not the
 * binding constraint after all.
 */
function consts(filter = ""): string {
	// An unbounded listing is the same mistake as an unbounded read. The first cut
	// of this tool returned 120 constants over 9,223 chars - larger than the
	// largest observation in the whole environment, so adding it would have raised
	// the floor and undone the terse result it was built to complement. A tool
	// shaped like the question still has to be bounded, so it takes a filter and
	// caps its output.
	const cap = TERSE ? 25 : 60;
	const needle = filter.trim().toLowerCase();
	const out: string[] = [];
	let total = 0;
	for (const f of FILES) {
		let body = "";
		try {
			body = readFileSync(join(ROOT, f), "utf8");
		} catch {
			continue;
		}
		body.split("\n").forEach((line, i) => {
			const m = line.match(/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*(.+?);?\s*$/);
			if (!m) return;
			if (needle && !m[1].toLowerCase().includes(needle)) return;
			total++;
			if (out.length < cap) out.push(`${f}:${i + 1}: ${m[1]} = ${m[2].slice(0, 40)}`);
		});
	}
	if (!out.length) return needle ? `no constants matching "${filter}"` : "no constants found";
	const more = total > out.length ? `\n... ${total - out.length} more; narrow with >consts <substring>` : "";
	return out.join("\n") + more;
}

/** Execute one shorthand op. Returns null when the line is not an op. */
function exec(line: string): string | null {
	const t = line.trim();
	let m = t.match(/^>?\s*ls\b/i);
	if (m) return FILES.join("\n");
	m = t.match(/^>?\s*consts?\b\s*(.*)$/i);
	if (m) return consts(normalisePattern(m[1] ?? ""));
	m = t.match(/^>?\s*grep\s+(.+)$/i);
	if (m) return grep(normalisePattern(m[1]));
	m = t.match(/^>?\s*read\s+(\S+)/i);
	if (m) return readFile(m[1]);
	return null;
}

const MENU =
	`Tools, one per reply, nothing else on the line:\n` +
	`  >ls              list files you may read\n` +
	`  >consts [text]   list declared CONSTANTS, optionally filtered by name\n` +
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
 * SLIDING: the clean test of the corrected rule.
 *
 * MINIMAL showed instruction volume is not the variable; the split was between
 * arms that CONTINUE a conversation (5/6) and arms that RECONSTRUCT state each
 * step (0-2/6). But those two groups also differed wildly in context size, so
 * continuity and size were confounded and either could be doing the work.
 *
 * SLIDING separates them. It is a continuing conversation - every turn is a
 * real prior turn, nothing is summarised or rebuilt - but the oldest middle
 * turns are dropped to hold a context budget matched to SELFBRIEF's ~1.2k
 * characters. Same footprint as the losing arms, same mechanism as the winning
 * ones.
 *
 * Prediction, committed before the run:
 *   - if CONTINUITY is the variable, SLIDING scores near ACCUMULATE (5/6)
 *     while using a fraction of the context
 *   - if TOTAL INFORMATION is the variable, SLIDING collapses toward SELFBRIEF
 *     and the real constraint is simply that a 9B needs the whole trail
 *
 * The first message is always kept: it carries the task and the tool menu, and
 * dropping it would change what the model was asked, not merely how much it
 * remembers.
 */
async function sliding(task: Task) {
	const budget = Number(arg("--budget", "5000"));
	// A window smaller than one observation cannot hold one observation, so every
	// tool result is dropped the moment it arrives and the model re-issues the
	// same command forever. The first run of this arm did exactly that: budget
	// 1400, a >ls listing of 2079 chars, peak context 404, and ">ls" emitted five
	// times in a row. It scored 1/6 and measured nothing except the budget.
	//
	// The floor is not a detail, it is the finding: you cannot compress an agentic
	// conversation below the size of a single observation. Context economy here is
	// bounded by TOOL OUTPUT SIZE, not by clever windowing - which points the real
	// lever at paginated reads and grep-over-read, not at history management.
	const floor = MENU.length + 400 + LARGEST_OBSERVATION;
	if (budget < floor) {
		throw new Error(
			`--budget ${budget} is below the floor of ${floor} (menu + task + the largest single ` +
			`observation, ${LARGEST_OBSERVATION} chars). Below this the window cannot hold one ` +
			`tool result and the arm measures the budget rather than the hypothesis.`,
		);
	}
	const head = { role: "user", content: `${MENU}\nTask: ${task.ask}\n\nReply with ONE tool line.` };
	let tail: { role: string; content: string }[] = [];
	let peak = 0;

	const window = () => {
		// Drop from the OLDEST end until the budget holds, always keeping head.
		const kept = [...tail];
		while (kept.length && head.content.length + kept.reduce((n, m) => n + m.content.length, 0) > budget) {
			kept.shift();
		}
		return [head, ...kept];
	};

	for (let step = 0; step < MAX_STEPS; step++) {
		const msgs = window();
		peak = Math.max(peak, msgs.reduce((n, m) => n + m.content.length, 0));
		const out = await llm(msgs);
		const fin = finalOf(out);
		if (fin) return { answer: fin, steps: step + 1, chars: peak };
		const obs = exec(out);
		tail.push({ role: "assistant", content: out });
		tail.push({
			role: "user",
			content: obs === null ? "Not a tool line. Reply with ONE tool line." : `${obs}\n\nReply with ONE tool line.`,
		});
	}
	const msgs = [...window(), { role: "user", content: "Now use >answer to give your final answer." }];
	peak = Math.max(peak, msgs.reduce((n, m) => n + m.content.length, 0));
	const last = await llm(msgs);
	return { answer: finalOf(last) ?? last, steps: MAX_STEPS, chars: peak };
}

/**
 * MINIMAL: the inverse test.
 *
 * If ACCUMULATE wins because it carries the LEAST instruction per step, then
 * carrying even less should win by more. That is a falsifiable claim and it is
 * the honest way to check the conclusion rather than admire it.
 *
 * ACCUMULATE still re-appends "Reply with ONE tool line." after every single
 * observation. MINIMAL states the menu once and then appends observations as
 * plain conversation, with nothing repeated. Same tools, same tasks, strictly
 * less instruction.
 *
 * Prediction, written before the run: if the least-instruction reading is
 * right, MINIMAL >= ACCUMULATE. If MINIMAL loses, then the repeated nudge is
 * doing real work and "less scaffolding" is too crude a rule - the honest
 * version would be that scaffolding must be cheap to PARSE, not merely small.
 */
async function minimal(task: Task) {
	const msgs = [{ role: "user", content: `${MENU}\nTask: ${task.ask}` }];
	let chars = 0;
	for (let step = 0; step < MAX_STEPS; step++) {
		const out = await llm(msgs);
		const fin = finalOf(out);
		if (fin) return { answer: fin, steps: step + 1, chars };
		const obs = exec(out);
		msgs.push({ role: "assistant", content: out });
		// No reminder, no re-instruction. Just what happened.
		msgs.push({ role: "user", content: obs === null ? "That is not one of the tools." : obs });
		chars = msgs.reduce((n, m) => n + m.content.length, 0);
	}
	const last = await llm([...msgs, { role: "user", content: ">answer" }]);
	return { answer: finalOf(last) ?? last, steps: MAX_STEPS, chars };
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

	// Which arms to run. Three arms over six tasks on a CPU 9B is ~25 minutes, so
	// a focused comparison is the difference between measuring and waiting.
	const ARMS = new Set(arg("--arms", "accumulate,selfbrief,trajectory,minimal,sliding").split(","));
	let aPass = 0;
	let sPass = 0;
	let tPass = 0;
	let mPass = 0;
	let slPass = 0;
	let aChars = 0;
	let sChars = 0;
	let tChars = 0;
	let mChars = 0;
	let slChars = 0;
	const blank = { answer: "", steps: 0, chars: 0 };

	for (const t of TASKS) {
		const a = ARMS.has("accumulate") ? await accumulate(t) : blank;
		const aOk = scores(a.answer, t);
		if (aOk) aPass++;
		aChars += a.chars;

		const s = ARMS.has("selfbrief") ? await selfbrief(t) : blank;
		const sOk = scores(s.answer, t);
		if (sOk) sPass++;
		sChars += s.chars;

		const tr = ARMS.has("trajectory") ? await trajectory(t) : blank;
		const tOk = scores(tr.answer, t);
		if (tOk) tPass++;
		tChars += tr.chars;

		const mi = ARMS.has("minimal") ? await minimal(t) : blank;
		const mOk = scores(mi.answer, t);
		if (mOk) mPass++;
		mChars += mi.chars;

		const sl = ARMS.has("sliding") ? await sliding(t) : blank;
		const slOk = scores(sl.answer, t);
		if (slOk) slPass++;
		slChars += sl.chars;

		console.log(`\n${t.id}`);
		if (ARMS.has("accumulate")) console.log(`  ACCUMULATE ${aOk ? "PASS" : "FAIL"}  ${a.steps} steps  ${a.chars} chars peak  -> ${JSON.stringify(a.answer.replace(/\s+/g, " ").slice(0, 80))}`);
		if (ARMS.has("selfbrief")) console.log(`  SELFBRIEF  ${sOk ? "PASS" : "FAIL"}  ${s.steps} steps  ${s.chars} chars peak  -> ${JSON.stringify(s.answer.replace(/\s+/g, " ").slice(0, 80))}`);
		if (ARMS.has("trajectory")) console.log(`  TRAJECTORY ${tOk ? "PASS" : "FAIL"}  ${tr.steps} steps  ${tr.chars} chars peak  -> ${JSON.stringify(tr.answer.replace(/\s+/g, " ").slice(0, 80))}`);
		if (ARMS.has("sliding")) console.log(`  SLIDING    ${slOk ? "PASS" : "FAIL"}  ${sl.steps} steps  ${sl.chars} chars peak  -> ${JSON.stringify(sl.answer.replace(/\s+/g, " ").slice(0, 80))}`);
		if (ARMS.has("minimal")) console.log(`  MINIMAL    ${mOk ? "PASS" : "FAIL"}  ${mi.steps} steps  ${mi.chars} chars peak  -> ${JSON.stringify(mi.answer.replace(/\s+/g, " ").slice(0, 80))}`);
	}

	const n = TASKS.length;
	console.log(`\n${"=".repeat(76)}`);
	if (ARMS.has("accumulate")) console.log(`ACCUMULATE  ${aPass}/${n}   ${Math.round(aChars / n)} chars peak context per task`);
	if (ARMS.has("selfbrief")) console.log(`SELFBRIEF   ${sPass}/${n}   ${Math.round(sChars / n)} chars peak context per task`);
	if (ARMS.has("trajectory")) console.log(`TRAJECTORY  ${tPass}/${n}   ${Math.round(tChars / n)} chars peak context per task`);
	if (ARMS.has("sliding")) console.log(`SLIDING     ${slPass}/${n}   ${Math.round(slChars / n)} chars peak context per task`);
	if (ARMS.has("minimal")) console.log(`MINIMAL     ${mPass}/${n}   ${Math.round(mChars / n)} chars peak context per task`);
	// Only compare arms that actually ran. A skipped arm scores 0 and printing a
	// delta against it reads as a catastrophic loss rather than as "not run" -
	// the same class of false reporting this whole suite exists to catch, and it
	// shipped here for one run before being noticed.
	const delta = (label: string, x: number, y: number, a: string, b: string, note = "") => {
		if (!ARMS.has(a) || !ARMS.has(b)) return;
		console.log(`${label} ${x - y >= 0 ? "+" : ""}${x - y} of ${n}${note}`);
	};
	console.log("");
	delta("selfbrief vs accumulate ", sPass, aPass, "selfbrief", "accumulate");
	delta("trajectory vs accumulate", tPass, aPass, "trajectory", "accumulate");
	delta("trajectory vs selfbrief  ", tPass, sPass, "trajectory", "selfbrief");
	delta("minimal vs accumulate   ", mPass, aPass, "minimal", "accumulate", "   <- less instruction, same protocol");
	delta("sliding vs accumulate   ", slPass, aPass, "sliding", "accumulate", "   <- continuity kept, context cut to selfbrief size");
	delta("sliding vs selfbrief    ", slPass, sPass, "sliding", "selfbrief", "   <- same footprint, opposite mechanism");
	console.log(`${n} tasks is a signal, not a proof. Ground truth is grepped from real files.`);

}
