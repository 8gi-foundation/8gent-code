/**
 * #3411: the quick-answer lane, end to end through a real Agent turn on the local
 * text-tool path, with the model stubbed (fixtures/quick-answer-probe.ts).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { CLARIFY_QUESTION, QUICK_LABEL, QUICK_TOOLS } from "../quick-answer";

afterAll(cleanupTempDirs);

type Probe = {
	reply: string;
	second: string | null;
	timeline: string[];
	provisionals: string[];
	history: string[];
	abortControllerAfter: boolean;
	seen: Array<{
		quick: boolean;
		proactive: boolean;
		tools: string[];
		model: string;
		reasoningEffort: string | null;
		chars: number;
		system: string;
		roles: string[];
	}>;
	runs: Array<{
		status?: string;
		tools?: number;
		quick?: {
			class: string;
			ran: boolean;
			ok: boolean;
			reason?: string;
			tools: number;
			model?: string;
			modelSource?: string;
			promptTokens?: number[];
			context?: boolean;
			asked?: boolean;
			shownMs?: number;
			verdict?: string;
			facts?: string[];
			text?: string;
		};
	}>;
	executed: string[];
};

function probe(
	mode: "answer" | "needs-deep" | "long-error",
	prompt: string,
	flag: string | undefined,
	extra: Record<string, string> = {},
): Probe {
	const root = tempDir("quick-answer-");
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "work"));
	const base = Object.fromEntries(
		Object.entries(process.env).filter(
			([k]) => k !== "EIGHT_QUICK_ANSWER" && k !== "EIGHT_QUICK_MODEL" && !k.startsWith("PROBE_"),
		),
	);
	const env = {
		...base,
		HOME: join(root, "home"),
		...(flag === undefined ? {} : { EIGHT_QUICK_ANSWER: flag }),
		...extra,
	};
	const r = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "fixtures", "quick-answer-probe.ts"),
			mode,
			join(root, "work"),
			prompt,
		],
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	const line = r.stdout
		.toString()
		.split("\n")
		.find((l) => l.startsWith("@@PROBE@@"));
	if (!line)
		throw new Error(
			`probe printed no result (exit ${r.exitCode}): ${r.stderr.toString().slice(-800)}`,
		);
	return JSON.parse(line.slice("@@PROBE@@".length));
}

const QUESTION = "which port does the server listen on?";
// The conv-quick-answer pilot prompt, verbatim from ~/.8gent/rishi-pilot/scenarios.json.
const PILOT_PROMPT =
	"Quick question, no need to change anything: if I start this server with APP_MODE=staging and no PORT set, which port does it listen on? And which one when APP_MODE isn't set at all? Just tell me in a sentence or two, then end your reply with exactly one line in this form: ANSWER: staging=<port> unset=<port>";
/** Chars the endpoint must process for the lane's first request (round 4: ~400 tok/s on the 9B). */
const LANE_FIRST_REQUEST_BUDGET = 4000;

describe("quick-answer lane in a real turn (#3411)", () => {
	test("flag on, quick prompt: a labelled provisional answer from read-only tools, then the full loop (#3416)", () => {
		const p = probe("answer", QUESTION, "1");
		expect(p.provisionals).toEqual([`${QUICK_LABEL} It listens on 4100.`]);
		const quick = p.seen.filter((s) => s.quick);
		expect(quick.length).toBeGreaterThan(0);
		for (const s of quick) for (const t of s.tools) expect(QUICK_TOOLS.has(t)).toBe(true);
		expect(quick[0].tools).toContain("read_file");
		expect(quick[0].tools).not.toContain("write_file");
		// PR1 ended the turn here; PR2 always runs the full loop after a shown quick answer.
		expect(p.timeline).toContain("full");
		expect(p.reply).toContain("full loop answer");
		expect(p.runs.at(-1)?.quick).toMatchObject({ class: "quick", ran: true, ok: true, tools: 1 });
	}, 60_000);

	test("flag on, model says NEEDS_DEEP: the full loop answers, with no quick answer and no verdict line", () => {
		const p = probe("needs-deep", QUESTION, "1");
		expect(p.reply).toContain("full loop answer");
		expect(p.reply).not.toContain(QUICK_LABEL);
		expect(p.provisionals).toEqual([]);
		expect(p.reply.startsWith("DONE") || p.reply.startsWith("full loop answer")).toBe(true);
		expect(p.runs.at(-1)?.quick?.verdict).toBe("none");
		expect(p.seen.some((s) => s.quick)).toBe(true);
		expect(p.seen.some((s) => !s.quick && s.tools.includes("write_file"))).toBe(true);
		expect(p.runs.at(-1)?.quick).toMatchObject({
			class: "quick",
			ran: true,
			ok: false,
			reason: "model asked for the full loop",
		});
	}, 60_000);

	test("flag on, an instruction: the lane never runs", () => {
		const p = probe("answer", "fix the port in server.ts", "1");
		expect(p.seen.some((s) => s.quick)).toBe(false);
		expect(p.runs.at(-1)?.quick).toMatchObject({ class: "deep", ran: false });
		expect(p.reply).not.toContain(QUICK_LABEL);
	}, 60_000);

	test("flag off (default): the lane never runs", () => {
		const p = probe("answer", QUESTION, undefined);
		expect(p.seen.some((s) => s.quick)).toBe(false);
		expect(p.runs.at(-1)?.quick).toBeUndefined();
		expect(p.reply).toContain("full loop answer");
	}, 60_000);

	test("flag on, a quoted quick prompt: no run_command runs, the pre-tool router stays off (8SO F1)", () => {
		const p = probe("answer", 'where is "apiKey" set?', "1");
		expect(p.runs.at(-1)?.quick?.class).toBe("quick");
		expect(p.executed).not.toContain("run_command");
		for (const name of p.executed) expect(QUICK_TOOLS.has(name)).toBe(true);
	}, 60_000);

	test("EIGHT_QUICK_MODEL unset: the lane runs on qwen3.5:9b when installed, and logs the pick", () => {
		const p = probe("answer", QUESTION, "1", { PROBE_TAGS: "probe:1b,qwen3.5:9b" });
		const quick = p.seen.filter((s) => s.quick);
		expect(quick.length).toBeGreaterThan(0);
		for (const s of quick) expect(s.model).toBe("qwen3.5:9b");
		expect(p.runs.at(-1)?.quick).toMatchObject({ model: "qwen3.5:9b", modelSource: "preferred" });
	}, 60_000);

	test("EIGHT_QUICK_MODEL set: it wins over the preferred model", () => {
		const p = probe("answer", QUESTION, "1", {
			PROBE_TAGS: "probe:1b,qwen3.5:9b",
			EIGHT_QUICK_MODEL: "probe:1b",
		});
		for (const s of p.seen.filter((x) => x.quick)) expect(s.model).toBe("probe:1b");
		expect(p.runs.at(-1)?.quick).toMatchObject({ model: "probe:1b", modelSource: "env" });
	}, 60_000);

	test("nothing preferred installed: the lane uses the session model", () => {
		const p = probe("answer", QUESTION, "1");
		for (const s of p.seen.filter((x) => x.quick)) expect(s.model).toBe("probe:1b");
		expect(p.runs.at(-1)?.quick).toMatchObject({ model: "probe:1b", modelSource: "session" });
	}, 60_000);

	test("lane requests turn thinking off; full-loop requests do not", () => {
		const p = probe("needs-deep", QUESTION, "1");
		const quick = p.seen.filter((s) => s.quick);
		const full = p.seen.filter((s) => !s.quick && s.tools.includes("write_file"));
		expect(quick.length).toBeGreaterThan(0);
		expect(full.length).toBeGreaterThan(0);
		for (const s of quick) expect(s.reasoningEffort).toBe("none");
		for (const s of full) expect(s.reasoningEffort).toBeNull();
	}, 60_000);

	test("a long lane failure reason is capped at 200 chars in the run log (8SO Q-R1)", () => {
		const p = probe("long-error", QUESTION, "1");
		const q = p.runs.at(-1)?.quick;
		expect(q).toMatchObject({ class: "quick", ran: true, ok: false });
		expect((q?.reason ?? "").length).toBeGreaterThan(0);
		expect((q?.reason ?? "").length).toBeLessThanOrEqual(200);
		expect(p.reply).toContain("full loop answer");
	}, 60_000);

	test("the lane's first request for the pilot prompt stays under the char budget, with no agent prompt or history", () => {
		const p = probe("answer", PILOT_PROMPT, "1");
		const quick = p.seen.filter((s) => s.quick);
		expect(quick.length).toBeGreaterThan(0);
		expect(quick[0].chars).toBeLessThan(LANE_FIRST_REQUEST_BUDGET);
		expect(quick[0].roles).toEqual(["system", "user"]);
		expect(quick[0].system).toContain("You are 8gent, answering a quick question");
		const full = p.seen.find((s) => !s.quick && s.tools.includes("write_file"));
		if (full) expect(full.system).not.toBe(quick[0].system);
	}, 60_000);

	test("prompt tokens per lane round go in the run log", () => {
		const p = probe("answer", QUESTION, "1");
		const q = p.runs.at(-1)?.quick;
		const rounds = p.seen.filter((s) => s.quick).length;
		expect(q?.promptTokens).toHaveLength(rounds);
		for (const t of q?.promptTokens ?? []) expect(t).toBeGreaterThan(0);
	}, 60_000);
});

// ── #3416: quick then full ────────────────────────────────────────────────
const CHECK_PROMPT = "which port does staging listen on?";
const WRONG_QUICK = "DONE: Staging listens on 5180.";
const RIGHT_QUICK = "DONE: Staging listens on 4180.";
const DEEP = "DONE: Staging listens on 4180, and on 3000 when APP_MODE is unset.";

describe("quick then full in a real turn (#3416)", () => {
	test("the provisional answer is shown before the full loop's first model request", () => {
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_QUICK_TEXT: RIGHT_QUICK,
			PROBE_DEEP_TEXT: DEEP,
		});
		const shown = p.timeline.indexOf("provisional");
		expect(shown).toBeGreaterThan(p.timeline.lastIndexOf("lane"));
		expect(p.timeline.indexOf("full")).toBeGreaterThan(shown);
	}, 60_000);

	test("the full loop never sees the quick answer", () => {
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_QUICK_TEXT: WRONG_QUICK,
			PROBE_DEEP_TEXT: DEEP,
		});
		const full = p.seen.filter((s) => !s.quick && s.tools.includes("write_file"));
		expect(full.length).toBeGreaterThan(0);
		for (const s of full) expect(s.system).not.toContain("5180");
	}, 60_000);

	test("a wrong quick answer: the final answer opens with the correction, and history holds only it", () => {
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_QUICK_TEXT: WRONG_QUICK,
			PROBE_DEEP_TEXT: DEEP,
		});
		expect(p.provisionals).toEqual([`${QUICK_LABEL} Staging listens on 5180.`]);
		expect(p.reply).toBe(
			"Correction: my quick answer (5180) did not match what I found when I checked. Use this instead:\n\nStaging listens on 4180, and on 3000 when APP_MODE is unset.",
		);
		expect(p.history).toEqual([p.reply]);
		expect(p.runs.at(-1)?.quick).toMatchObject({
			verdict: "corrected",
			facts: ["5180"],
			text: "Staging listens on 5180.",
		});
		expect(typeof p.runs.at(-1)?.quick?.shownMs).toBe("number");
	}, 60_000);

	test("a right quick answer: the final answer opens with Checked", () => {
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_QUICK_TEXT: RIGHT_QUICK,
			PROBE_DEEP_TEXT: DEEP,
		});
		expect(p.reply).toBe(
			"Checked: my quick answer (4180) was right.\n\nStaging listens on 4180, and on 3000 when APP_MODE is unset.",
		);
		expect(p.runs.at(-1)?.quick?.verdict).toBe("confirmed");
	}, 60_000);

	test("a quick answer with no comparable fact: the full answer is labelled as not compared", () => {
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_QUICK_TEXT: "DONE: It is set in src/server.ts.",
			PROBE_DEEP_TEXT: DEEP,
		});
		expect(p.reply.split("\n")[0]).toBe(
			"Full answer (I could not compare it with my quick answer):",
		);
		expect(p.runs.at(-1)?.quick?.verdict).toBe("unknown");
	}, 60_000);

	test("ESC during the quick answer ends the turn: no full-loop request at all", () => {
		const p = probe("answer", CHECK_PROMPT, "1", { PROBE_ESC: "lane" });
		expect(p.timeline).toContain("lane");
		expect(p.timeline).not.toContain("full");
		expect(p.provisionals).toEqual([]);
		expect(p.runs.at(-1)?.quick).toMatchObject({ ran: true, ok: false, reason: "aborted" });
		expect(p.runs.at(-1)).toMatchObject({ status: "error" });
		expect(p.history).toEqual([p.reply]);
	}, 60_000);

	test("ESC during the full loop: the stopped line names the quick facts", () => {
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_QUICK_TEXT: WRONG_QUICK,
			PROBE_ESC: "deep",
		});
		expect(p.provisionals.length).toBe(1);
		expect(p.reply).toBe(
			"Stopped before I could check my quick answer (5180), so do not rely on it.",
		);
		expect(p.history).toEqual([p.reply]);
		expect(p.runs.at(-1)?.quick?.verdict).toBe("stopped");
	}, 60_000);

	test("the full loop fails: the unchecked line with a next step replaces the error text", () => {
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_QUICK_TEXT: WRONG_QUICK,
			PROBE_DEEP_FAIL: "1",
		});
		expect(p.reply).toBe(
			"I could not check my quick answer (5180), so do not rely on it. Try asking again, or narrow the question.",
		);
		expect(p.runs.at(-1)?.quick?.verdict).toBe("unchecked");
	}, 60_000);

	test("a full answer the honesty gate rewrites is never confirmed", () => {
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_QUICK_TEXT: RIGHT_QUICK,
			PROBE_DEEP_TEXT: "DONE: The fix has been committed and pushed. Staging listens on 4180.",
		});
		expect(p.runs.at(-1)?.quick?.verdict).toBe("unchecked");
		expect(
			p.reply.startsWith("I could not check my quick answer (4180), so do not rely on it."),
		).toBe(true);
		expect(p.reply).not.toContain("Try asking again");
	}, 60_000);

	test("flag on, `why?` as the first message: the one fixed question, no model request", () => {
		const p = probe("answer", "why?", "1");
		expect(p.reply).toBe(CLARIFY_QUESTION);
		expect(p.seen).toEqual([]);
		expect(p.history).toEqual([CLARIFY_QUESTION]);
	}, 60_000);

	test("the reply to the question is answered, never asked again", () => {
		const p = probe("answer", "why?", "1", { PROBE_SECOND: "hmm" });
		expect(p.reply).toBe(CLARIFY_QUESTION);
		expect(p.second).not.toBe(CLARIFY_QUESTION);
		expect(p.second).toContain("full loop answer");
	}, 60_000);

	test("flag on, `why?` after one exchange goes to the full loop with no question", () => {
		const p = probe("needs-deep", QUESTION, "1", { PROBE_SECOND: "why?" });
		expect(p.second).toContain("full loop answer");
		expect(p.second).not.toBe(CLARIFY_QUESTION);
		expect(p.seen.every((s) => !s.proactive)).toBe(true);
	}, 60_000);

	test("flag on, the pilot prompt gets no [PROACTIVE QUESTIONING] note", () => {
		const p = probe("answer", PILOT_PROMPT, "1");
		expect(p.runs.at(-1)?.quick?.class).toBe("quick");
		expect(p.seen.length).toBeGreaterThan(0);
		expect(p.seen.every((s) => !s.proactive)).toBe(true);
	}, 60_000);

	test("flag on, a context-dependent follow-up: classed deep, logged, and no lane request", () => {
		const p = probe("answer", "which port?", "1");
		expect(p.seen.some((s) => s.quick)).toBe(false);
		expect(p.runs.at(-1)?.quick).toMatchObject({ class: "deep", context: true, ran: false });
	}, 60_000);

	test("flag on, no onProvisional (Telegram, the daemon): no lane request and no verdict line", () => {
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_NO_PROVISIONAL: "1",
			PROBE_QUICK_TEXT: WRONG_QUICK,
			PROBE_DEEP_TEXT: DEEP,
		});
		expect(p.seen.some((s) => s.quick)).toBe(false);
		expect(p.reply).not.toMatch(/quick answer/i);
		expect(p.reply).toContain("Staging listens on 4180");
		expect(p.runs.at(-1)?.quick).toMatchObject({ class: "quick", ran: false, verdict: "none" });
	}, 60_000);

	test("flag on, no onProvisional: a vague first message gets the flag-off gate's note (R3.3)", () => {
		const on = probe("answer", "why?", "1", { PROBE_NO_PROVISIONAL: "1" });
		const off = probe("answer", "why?", undefined, { PROBE_NO_PROVISIONAL: "1" });
		expect(off.seen.some((s) => s.proactive)).toBe(true);
		expect(on.seen.some((s) => s.proactive)).toBe(true);
		expect(on.reply).not.toBe(CLARIFY_QUESTION);
	}, 60_000);

	test("a secret in the quick answer leaves no trace in runs.jsonl or history", () => {
		const key = `sk-${"Q7w8E9r0".repeat(4)}`;
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_QUICK_TEXT: `DONE: Staging listens on 5180 with the key \`${key}\`.`,
			PROBE_DEEP_TEXT: DEEP,
		});
		expect(p.provisionals.length).toBe(1);
		expect(JSON.stringify(p.runs)).not.toContain(key);
		expect(JSON.stringify(p.runs)).not.toContain("Q7w8E9r0");
		expect(JSON.stringify(p.history)).not.toContain("Q7w8E9r0");
		expect(p.runs.at(-1)?.quick?.facts).toEqual(["5180"]);
		expect(p.reply.split("\n")[0]).toBe(
			"Correction: my quick answer (5180) did not match what I found when I checked. Use this instead:",
		);
	}, 60_000);

	// Each shape the redactor learned in fix/redact-key-shapes, end to end: nothing of the
	// secret may reach runs.jsonl (facts, text), the verdict line, or history.
	for (const [shape, secret, fragment] of [
		["OpenAI sk-proj-", `sk-proj-${"Hq3_Lm7-Vt9".repeat(3)}`, "Hq3_Lm7"],
		["Bearer token", `Bearer ${"dG9rZW4tVk".repeat(3)}x.y~z`, "dG9rZW4tVk"],
		["Stripe live key", `sk_live_${"Pq81Rs27Tu".repeat(2)}`, "Pq81Rs27Tu"],
		["URL credentials", "postgres://ops:Wy5hunter7pass@db.internal:5432/app", "Wy5hunter7pass"],
	] as const) {
		test(`a ${shape} in the quick answer leaves no trace in the log, the verdict line or history`, () => {
			const p = probe("answer", CHECK_PROMPT, "1", {
				PROBE_QUICK_TEXT: `DONE: Staging listens on 5180, connect with \`${secret}\`.`,
				PROBE_DEEP_TEXT: DEEP,
			});
			expect(p.provisionals.length).toBe(1);
			const quick = p.runs.at(-1)?.quick;
			expect(quick?.facts).toEqual(["5180"]);
			expect(quick?.text ?? "").not.toContain(fragment);
			expect(JSON.stringify(p.runs)).not.toContain(fragment);
			expect(p.reply.split("\n")[0]).toBe(
				"Correction: my quick answer (5180) did not match what I found when I checked. Use this instead:",
			);
			expect(p.reply).not.toContain(fragment);
			expect(JSON.stringify(p.history)).not.toContain(fragment);
		}, 60_000);
	}

	test("verdict line names numbers first and drops ALL_CAPS words echoed from the prompt", () => {
		const p = probe("answer", PILOT_PROMPT, "1", {
			PROBE_QUICK_TEXT:
				"DONE: With APP_MODE=staging and no PORT it uses 3001.\nANSWER: staging=3001 unset=3000",
			PROBE_DEEP_TEXT: "DONE: Staging uses 4180, unset uses 3000.\nANSWER: staging=4180 unset=3000",
		});
		expect(p.reply.split("\n")[0]).toBe(
			"Correction: my quick answer (3001, 3000) did not match what I found when I checked. Use this instead:",
		);
	}, 60_000);

	test("the one-question path writes a quick record to runs.jsonl", () => {
		const p = probe("answer", "why?", "1");
		expect(p.reply).toBe(CLARIFY_QUESTION);
		expect(p.runs).toHaveLength(1);
		expect(p.runs[0]).toMatchObject({ status: "ok", tools: 0 });
		expect(p.runs[0].quick).toMatchObject({
			class: "unclear",
			ran: false,
			asked: true,
			verdict: "none",
		});
	}, 60_000);

	test("a display error in onProvisional never breaks the turn", () => {
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_QUICK_TEXT: RIGHT_QUICK,
			PROBE_DEEP_TEXT: DEEP,
			PROBE_PROVISIONAL_THROW: "1",
			PROBE_SECOND: "and on staging?",
		});
		expect(p.reply.startsWith("Checked: my quick answer (4180) was right.")).toBe(true);
		expect(p.second).toContain("Staging listens on 4180");
		expect(p.abortControllerAfter).toBe(false);
	}, 60_000);

	test("ESC after the full answer came back: compared, never 'Stopped before'", () => {
		const p = probe("answer", CHECK_PROMPT, "1", {
			PROBE_QUICK_TEXT: RIGHT_QUICK,
			PROBE_DEEP_TEXT: DEEP,
			PROBE_ESC: "after-deep",
		});
		expect(p.reply).not.toContain("Stopped before");
		expect(p.reply.startsWith("Checked: my quick answer (4180) was right.")).toBe(true);
		expect(p.runs.at(-1)?.quick?.verdict).toBe("confirmed");
	}, 60_000);

	test("native tool path (EIGHT_TEXT_TOOLS=0): flag on behaves as flag off, no question asked", () => {
		const on = probe("answer", "why?", "1", { EIGHT_TEXT_TOOLS: "0" });
		const off = probe("answer", "why?", undefined, { EIGHT_TEXT_TOOLS: "0" });
		expect(on.reply).not.toBe(CLARIFY_QUESTION);
		expect(on.provisionals).toEqual([]);
		expect(on.seen.some((s) => s.quick)).toBe(false);
		expect(on.seen.map((s) => s.proactive)).toEqual(off.seen.map((s) => s.proactive));
	}, 60_000);

	for (const prompt of [
		QUESTION,
		"why?",
		PILOT_PROMPT,
		"fix the port in server.ts",
		"which port?",
	]) {
		test(`flag off: byte-identical with or without onProvisional (${JSON.stringify(prompt.slice(0, 30))})`, () => {
			const extra = { PROBE_QUICK_TEXT: WRONG_QUICK, PROBE_DEEP_TEXT: DEEP };
			const withCb = probe("answer", prompt, undefined, extra);
			const without = probe("answer", prompt, undefined, { ...extra, PROBE_NO_PROVISIONAL: "1" });
			const zero = probe("answer", prompt, "0", extra);
			for (const p of [withCb, zero]) {
				expect(p.reply).toBe(without.reply);
				expect(p.seen).toEqual(without.seen);
				expect(p.executed).toEqual(without.executed);
				expect(p.provisionals).toEqual([]);
			}
			expect(withCb.runs.map((r) => r.quick)).toEqual(without.runs.map(() => undefined));
		}, 120_000);
	}
});
