/**
 * Pre-send draft check (#4191). The three msg-post-tool rows are the texts the local model really
 * posted on 13 Oct 2026 (runs 150728 PASS, 151655 FAIL, 152210 FAIL), with the scenario's prompt.
 */

import { describe, expect, test } from "bun:test";
import {
	checkDraftConstraints,
	countNumbers,
	describeFailures,
	extractConstraints,
	maxWordRepeat,
	namedSources,
} from "./draft-constraints";

const TASK =
	'Post a short summary of the latest pilot run to the group on Telegram with the post_message tool, input {"chat": "-1004417730052", "text": "<your 4 lines>"}. The sending notes are in POSTING.md and the run is in last-run/result.json. Use exactly 4 lines of plain text, include exactly 3 numbers, and do not use any word more than twice. Send it once.';

const RUN1_PASS =
	"Run ops-cron-backup finished with a FAIL verdict.\nChecks passed 11 out of 12 total items.\nThe old_backups_pruned item did not clear.\nElapsed time was 487 seconds.";
const RUN2_FAIL =
	"Run ops-cron-backup finished with a FAIL verdict\nChecks passed 11/12, old_backups_pruned did not clear\nThe run took 487 seconds to finish\nNo faults were logged on the host";
const RUN3_FAIL =
	"ops-cron-backup on M2\n11 of 12 checks passed in 487 seconds\nverdict FAIL: old_backups_pruned\n1 fault, none recorded";

/** The fixture's last-run/result.json, byte for byte in content. */
const RESULT_JSON = JSON.stringify(
	{
		scenario: "ops-cron-backup",
		machine: "M2",
		pass: false,
		checksPass: "11/12",
		failed_check: "old_backups_pruned",
		faults: [],
		secs: 487,
		started_at: "2026-10-05T14:02:11Z",
	},
	null,
	2,
);

describe("msg-post-tool evidence (the three posted texts)", () => {
	test("the scenario prompt yields lines, numbers and word-repeat rules, and nothing from the placeholder", () => {
		const c = extractConstraints(TASK);
		expect(c.map((x) => x.type).sort()).toEqual(["lines", "numbers", "word_repeats"]);
		expect(c.find((x) => x.type === "lines")).toMatchObject({ cmp: "eq", n: 4 });
		expect(c.find((x) => x.type === "numbers")).toMatchObject({ cmp: "eq", n: 3 });
		expect(c.find((x) => x.type === "word_repeats")).toMatchObject({ max: 2 });
	});

	test("run 150728 (judge PASS) passes", () => {
		const v = checkDraftConstraints(TASK, RUN1_PASS);
		expect(v.ok).toBe(true);
		expect(v.results.find((r) => r.constraint.type === "numbers")?.detail).toBe(
			"3 number(s), want exactly 3",
		);
	});

	test("run 151655 (judge: 2 numbers) fails on numbers only", () => {
		const v = checkDraftConstraints(TASK, RUN2_FAIL);
		expect(v.ok).toBe(false);
		expect(v.failed.map((f) => f.constraint.type)).toEqual(["numbers"]);
		expect(v.failed[0].detail).toBe("2 number(s), want exactly 3");
	});

	test("run 152210 (judge: 5 numbers) fails on numbers", () => {
		const v = checkDraftConstraints(TASK, RUN3_FAIL);
		expect(v.failed.map((f) => f.constraint.type)).toEqual(["numbers"]);
		expect(v.failed[0].detail).toBe("5 number(s), want exactly 3");
		expect(describeFailures(v)).toBe('"exactly 3 numbers": 5 number(s), want exactly 3');
	});

	test("run 152210 with a stated source rule also catches the invented 1, as the judge did", () => {
		const task = `${TASK} Use only numbers from last-run/result.json.`;
		expect(namedSources(task)).toEqual(["last-run/result.json"]);
		const v = checkDraftConstraints(task, RUN3_FAIL, { "last-run/result.json": RESULT_JSON });
		const src = v.results.find((r) => r.constraint.type === "numbers_from_source");
		expect(src?.pass).toBe(false);
		expect(src?.detail).toBe("not in last-run/result.json: 1");
		expect(checkDraftConstraints(task, RUN1_PASS, { "last-run/result.json": RESULT_JSON }).ok).toBe(
			true,
		);
	});
});

describe("IFBench count:numbers semantics", () => {
	test('"11/12" is one number, "11 of 12" is two', () => {
		expect(countNumbers("11/12")).toBe(1);
		expect(countNumbers("11 of 12")).toBe(2);
		expect(countNumbers("11 out of 12, 487 seconds")).toBe(3);
	});
	test("punctuation joins digits; letters split them", () => {
		expect(countNumbers("3.5")).toBe(1);
		expect(countNumbers("1,000")).toBe(1);
		expect(countNumbers("M2 on old_backups_pruned")).toBe(1);
		expect(countNumbers("no digits here")).toBe(0);
	});
	test("words:repeats lowercases and strips punctuation", () => {
		expect(maxWordRepeat("The run. the RUN, the end")).toEqual(["the", 3]);
	});
});

describe("constraint types", () => {
	test("numbers: at most / at least / word counts", () => {
		expect(checkDraftConstraints("include at most two numbers", "1 2 3").ok).toBe(false);
		expect(checkDraftConstraints("include at most two numbers", "1 2").ok).toBe(true);
		expect(checkDraftConstraints("use at least 2 numbers", "only 1").ok).toBe(false);
		expect(checkDraftConstraints("use no more than 1 number", "7").ok).toBe(true);
	});

	test("lines: exactly wants no blank lines; at most counts", () => {
		expect(checkDraftConstraints("write exactly 2 lines", "a\nb").ok).toBe(true);
		expect(checkDraftConstraints("write exactly 2 lines", "a\n\nb").ok).toBe(false);
		expect(checkDraftConstraints("in at most 3 short lines", "a\nb\nc\nd").failed[0].detail).toBe(
			"4 line(s), want at most 3",
		);
		expect(checkDraftConstraints("at most 3 lines", "  a\nb\n").ok).toBe(true);
	});

	test("an unqualified count is not a rule", () => {
		expect(extractConstraints("post your 4 lines with 3 numbers")).toEqual([]);
	});

	test("word repeats: once, twice, N times", () => {
		expect(checkDraftConstraints("do not use any word more than once", "go go").ok).toBe(false);
		expect(checkDraftConstraints("no word more than 3 times", "a a a").ok).toBe(true);
		expect(checkDraftConstraints("no word more than 3 times", "a a a a").ok).toBe(false);
	});

	test("no emoji", () => {
		expect(checkDraftConstraints("Plain text, no emoji.", "done \u{1F680}").ok).toBe(false);
		expect(checkDraftConstraints("do not use any emojis", "done").ok).toBe(true);
	});

	test("no em dash", () => {
		expect(checkDraftConstraints("no em dashes", "a \u2014 b").ok).toBe(false);
		expect(checkDraftConstraints("without any em-dash", "a - b").ok).toBe(true);
	});

	test("numbers from a source: unchecked when the source is missing, never a failure", () => {
		const task = "every number must appear in notes/facts.txt";
		const v = checkDraftConstraints(task, "42 apples");
		expect(v.ok).toBe(true);
		expect(v.results[0].pass).toBeNull();
		expect(checkDraftConstraints(task, "42 apples", { "notes/facts.txt": "apples: 042" }).ok).toBe(
			true,
		);
		expect(checkDraftConstraints(task, "43 apples", { "notes/facts.txt": "apples: 042" }).ok).toBe(
			false,
		);
	});

	test("must name a quoted string, case-insensitive", () => {
		const task = 'You must name "ops-cron-backup" in the message.';
		expect(checkDraftConstraints(task, "OPS-CRON-BACKUP failed").ok).toBe(true);
		expect(checkDraftConstraints(task, "the backup failed").failed[0].detail).toBe(
			'"ops-cron-backup" missing',
		);
		expect(extractConstraints("Always mention the word 'Rishi'.")[0]).toMatchObject({
			type: "must_name",
			value: "Rishi",
		});
	});

	test("a task with no countable rules passes any draft", () => {
		expect(checkDraftConstraints("Post a quick hello to the group.", "Hello 1 2 3 4 5").ok).toBe(
			true,
		);
	});
});
