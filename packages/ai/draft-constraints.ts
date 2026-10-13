/**
 * Pre-send draft check (#4191). Pure: task text and draft in, verdict out. No model, no I/O.
 *
 * A local model cannot reliably hold a countable rule ("exactly 3 numbers") in one draft, and an
 * outward post cannot be taken back. So before post_message sends, the countable rules the task
 * states are read out of the task text and counted in the draft with code.
 *
 * Counting follows the pilot's judges (IFBench check_following ports):
 *   numbers       strip Python string.punctuation, then count \p{Nd}+ runs ("11/12" is one, "11 of 12" two)
 *   word repeats  lowercase, strip punctuation, split on whitespace, highest count
 *   lines         trim, split on \n; an exact count also wants every line non-empty
 *   from source   every raw \d+ run, as a number, must occur as a \d+ run in the named source
 */

export type Cmp = "eq" | "le" | "ge" | "lt" | "gt";

export type DraftConstraint =
	| { type: "numbers"; cmp: Cmp; n: number; phrase: string }
	| { type: "lines"; cmp: Cmp; n: number; phrase: string }
	| { type: "word_repeats"; max: number; phrase: string }
	| { type: "no_emoji"; phrase: string }
	| { type: "no_em_dash"; phrase: string }
	| { type: "numbers_from_source"; path: string; phrase: string }
	| { type: "must_name"; value: string; phrase: string };

export interface ConstraintResult {
	constraint: DraftConstraint;
	/** null: the rule could not be checked (its source was not supplied). It never fails a draft. */
	pass: boolean | null;
	detail: string;
}

export interface DraftVerdict {
	ok: boolean;
	results: ConstraintResult[];
	failed: ConstraintResult[];
}

/** The typed stop for a draft that broke a task rule twice (#4174 stop shape). */
export interface FormattingStop {
	kind: "formatting_rule_violation";
	reason: string;
	constraint: string;
	draft: string;
}

const WORDS: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
};
const COUNT = `(\\d{1,3}|${Object.keys(WORDS).join("|")})`;
const QUAL = "(exactly|at most|no more than|up to|at least|fewer than|less than|more than)";
const QUAL_CMP: Record<string, Cmp> = {
	exactly: "eq",
	"at most": "le",
	"no more than": "le",
	"up to": "le",
	"at least": "ge",
	"fewer than": "lt",
	"less than": "lt",
	"more than": "gt",
};
const CMP_WORD: Record<Cmp, string> = {
	eq: "exactly",
	le: "at most",
	ge: "at least",
	lt: "fewer than",
	gt: "more than",
};

const toN = (s: string): number => WORDS[s.toLowerCase()] ?? Number(s);
const cmpOk = (cmp: Cmp, got: number, n: number): boolean =>
	cmp === "eq"
		? got === n
		: cmp === "le"
			? got <= n
			: cmp === "ge"
				? got >= n
				: cmp === "lt"
					? got < n
					: got > n;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Python's string.punctuation, as the IFBench checkers strip it. */
const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

/** IFBench count:numbers. */
export function countNumbers(text: string): number {
	return (text.replace(PUNCT, "").match(/\p{Nd}+/gu) ?? []).length;
}

/** IFBench words:repeats: the most repeated word and its count. */
export function maxWordRepeat(text: string): [string, number] {
	const seen = new Map<string, number>();
	for (const w of text.toLowerCase().replace(PUNCT, "").split(/\s+/).filter(Boolean))
		seen.set(w, (seen.get(w) ?? 0) + 1);
	let top: [string, number] = ["", 0];
	for (const [w, c] of seen) if (c > top[1]) top = [w, c];
	return top;
}

/** The countable rules a task states. Unqualified counts ("your 4 lines") are not rules. */
export function extractConstraints(task: string): DraftConstraint[] {
	const out: DraftConstraint[] = [];
	const t = task ?? "";
	for (const m of t.matchAll(
		new RegExp(`\\b${QUAL}\\s+${COUNT}\\s+(?:different\\s+|distinct\\s+)?numbers?\\b`, "gi"),
	))
		out.push({
			type: "numbers",
			cmp: QUAL_CMP[m[1].toLowerCase()],
			n: toN(m[2]),
			phrase: norm(m[0]),
		});
	for (const m of t.matchAll(
		new RegExp(`\\b${QUAL}\\s+${COUNT}\\s+(?:[a-z]+\\s+)?lines?\\b`, "gi"),
	))
		out.push({
			type: "lines",
			cmp: QUAL_CMP[m[1].toLowerCase()],
			n: toN(m[2]),
			phrase: norm(m[0]),
		});
	const rep =
		/\b(?:do not|don't|never)\s+use\s+(?:any|a|the same)\s+word\s+more\s+than\s+(once|twice|thrice|(\d{1,2}|[a-z]+)\s+times)\b|\bno\s+word\s+more\s+than\s+(once|twice|thrice|(\d{1,2}|[a-z]+)\s+times)\b/i.exec(
			t,
		);
	if (rep) {
		const w = (rep[1] ?? rep[3]).toLowerCase();
		const n = w === "once" ? 1 : w === "twice" ? 2 : w === "thrice" ? 3 : toN(rep[2] ?? rep[4]);
		if (Number.isFinite(n)) out.push({ type: "word_repeats", max: n, phrase: norm(rep[0]) });
	}
	const emoji =
		/\b(?:no|without(?:\s+any)?|(?:do not|don't|never)\s+use(?:\s+any)?)\s+emojis?\b/i.exec(t);
	if (emoji) out.push({ type: "no_emoji", phrase: norm(emoji[0]) });
	const dash =
		/\b(?:no|without|avoid(?:ing)?|(?:do not|don't|never)\s+use)(?:\s+(?:any|an?|the))?(?:\s+[a-z]+){0,2}?\s+em[\s-]?dash(?:es)?\b/i.exec(
			t,
		);
	if (dash) out.push({ type: "no_em_dash", phrase: norm(dash[0]) });
	for (const m of t.matchAll(
		/\b(?:only|every|each|all)\b[^.\n]{0,40}?\bnumbers?\b[^\n]{0,40}?\b(?:from|in)\s+[`"']?([\w-]+(?:\/[\w.-]+)*\.[A-Za-z]{1,5})\b/gi,
	))
		out.push({ type: "numbers_from_source", path: m[1], phrase: norm(m[0]) });
	for (const m of t.matchAll(
		/\b(?:must|should|be sure to|always)\s+(?:name|mention|include|contain)\s+(?:the\s+(?:word|phrase|name|string)\s+)?["“`']([^"”`'\n]{1,80})["”`']/gi,
	))
		out.push({ type: "must_name", value: m[1], phrase: norm(m[0]) });
	return out;
}

function check(
	c: DraftConstraint,
	draft: string,
	sources: Record<string, string>,
): ConstraintResult {
	switch (c.type) {
		case "numbers": {
			const got = countNumbers(draft);
			return {
				constraint: c,
				pass: cmpOk(c.cmp, got, c.n),
				detail: `${got} number(s), want ${CMP_WORD[c.cmp]} ${c.n}`,
			};
		}
		case "lines": {
			const lines = draft.replace(/\r\n/g, "\n").trim().split("\n");
			const blank = lines.filter((l) => l.trim() === "").length;
			const pass = cmpOk(c.cmp, lines.length, c.n) && (c.cmp !== "eq" || blank === 0);
			return {
				constraint: c,
				pass,
				detail: `${lines.length} line(s)${blank ? `, ${blank} blank` : ""}, want ${CMP_WORD[c.cmp]} ${c.n}`,
			};
		}
		case "word_repeats": {
			const [w, n] = maxWordRepeat(draft);
			return {
				constraint: c,
				pass: n <= c.max,
				detail: `"${w}" appears ${n} time(s), max ${c.max}`,
			};
		}
		case "no_emoji": {
			const hit = /\p{Extended_Pictographic}/u.exec(draft);
			return { constraint: c, pass: !hit, detail: hit ? `emoji ${hit[0]} present` : "none" };
		}
		case "no_em_dash": {
			const pass = !draft.includes("\u2014");
			return { constraint: c, pass, detail: pass ? "none" : "em dash present" };
		}
		case "numbers_from_source": {
			const src = sources[c.path];
			if (src === undefined)
				return { constraint: c, pass: null, detail: `${c.path} not supplied, not checked` };
			const allowed = new Set((src.match(/\d+/g) ?? []).map((d) => String(Number(d))));
			const invented = [
				...new Set((draft.match(/\d+/g) ?? []).map((d) => String(Number(d)))),
			].filter((d) => !allowed.has(d));
			return {
				constraint: c,
				pass: invented.length === 0,
				detail: invented.length
					? `not in ${c.path}: ${invented.join(", ")}`
					: `every number is in ${c.path}`,
			};
		}
		case "must_name": {
			const pass = draft.toLowerCase().includes(c.value.toLowerCase());
			return { constraint: c, pass, detail: pass ? `names "${c.value}"` : `"${c.value}" missing` };
		}
	}
}

/**
 * Check a draft against the countable rules in the task. `sources` maps a path the task names
 * ("only numbers from last-run/result.json") to that file's text; a missing source is unchecked.
 */
export function checkDraftConstraints(
	task: string,
	draft: string,
	sources: Record<string, string> = {},
): DraftVerdict {
	const results = extractConstraints(task).map((c) => check(c, draft ?? "", sources));
	const failed = results.filter((r) => r.pass === false);
	return { ok: failed.length === 0, results, failed };
}

/** The source paths a task's numbers_from_source rules name, for the caller to read. */
export function namedSources(task: string): string[] {
	return [
		...new Set(
			extractConstraints(task).flatMap((c) => (c.type === "numbers_from_source" ? [c.path] : [])),
		),
	];
}

/** One line per failed rule: the task's own words, then what the draft has. */
export function describeFailures(v: DraftVerdict): string {
	return v.failed.map((f) => `"${f.constraint.phrase}": ${f.detail}`).join("; ");
}
