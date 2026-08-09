import { describe, expect, test } from "bun:test";
import {
	BOARD_ROSTER,
	EditThrottle,
	MAX_VERDICT_WORDS,
	type Officer,
	type OfficerRow,
	VOICE_BY_OFFICER,
	clampVerdict,
	normaliseOfficerText,
	renderBoard,
	runBoardroom,
} from "./boardroom";

describe("normaliseOfficerText", () => {
	test("drops the sign-off block", () => {
		expect(normaliseOfficerText("Ship it.\n\nVOICE: say -v Rishi")).toBe("Ship it.");
	});

	test("replaces em dashes, which the house style bans on every surface", () => {
		expect(normaliseOfficerText("Opt-in only — the contract settles it.")).toBe(
			"Opt-in only - the contract settles it.",
		);
		expect(normaliseOfficerText("a – b")).toBe("a - b");
	});

	test("drops a leading Verdict: label so it is not printed twice", () => {
		expect(normaliseOfficerText("Verdict: opt-in only.")).toBe("opt-in only.");
	});
});

const rowsFor = (roster: Officer[]): OfficerRow[] =>
	roster.map((officer) => ({ officer, status: "pending" as const }));

describe("roster", () => {
	test("is the full board of eight", () => {
		expect(BOARD_ROSTER).toHaveLength(8);
	});

	test("every officer has a voice in the contract map", () => {
		for (const o of BOARD_ROSTER) expect(VOICE_BY_OFFICER[o.name]).toBeTruthy();
	});

	test("officer codes are unique", () => {
		expect(new Set(BOARD_ROSTER.map((o) => o.code)).size).toBe(8);
	});
});

describe("renderBoard", () => {
	test("shows every officer as waiting before anyone reports", () => {
		const text = renderBoard("Should we ship X?", rowsFor(BOARD_ROSTER));
		for (const o of BOARD_ROSTER) expect(text).toContain(o.code);
		expect(text).toContain("0/8 reported");
	});

	test("a done officer shows a one-line summary, not the whole brief", () => {
		const rows = rowsFor(BOARD_ROSTER);
		rows[1].status = "done";
		rows[1].brief = `${"x".repeat(400)}\nsecond line`;
		const text = renderBoard("topic", rows);
		expect(text).not.toContain("second line");
		expect(text.split("\n").every((l) => l.length < 200)).toBe(true);
	});

	test("a timeout finalises with what did land rather than a spinner", () => {
		const rows = rowsFor(BOARD_ROSTER);
		rows[0].status = "done";
		rows[0].brief = "yes";
		const text = renderBoard("topic", rows, { timedOut: true });
		expect(text).toContain("Timed out at 8 minutes");
		expect(text).toContain("1 of 8 officers reported");
	});

	test("a long topic is truncated so the header cannot dominate the message", () => {
		expect(renderBoard("t".repeat(500), rowsFor(BOARD_ROSTER))).toContain("...");
	});
});

describe("clampVerdict", () => {
	test("leaves a short verdict alone", () => {
		expect(clampVerdict("Ship it. Karen dissents on the token.")).toBe(
			"Ship it. Karen dissents on the token.",
		);
	});

	test("enforces the word ceiling even when the model ignores it", () => {
		const clamped = clampVerdict("word ".repeat(200));
		expect(clamped.split(" ").length).toBe(MAX_VERDICT_WORDS);
		expect(clamped.endsWith("...")).toBe(true);
	});
});

describe("EditThrottle", () => {
	test("coalesces a burst into one edit instead of one per officer", async () => {
		const seen: string[] = [];
		let now = 0;
		const t = new EditThrottle(
			async (text) => {
				seen.push(text);
			},
			5000,
			20,
			() => now,
		);
		for (let i = 0; i < 8; i++) t.request(`state ${i}`);
		expect(seen).toHaveLength(1); // the first one goes out immediately
		expect(seen[0]).toBe("state 0");
	});

	test("stops editing once the budget is spent", async () => {
		let now = 0;
		let count = 0;
		const t = new EditThrottle(
			async () => {
				count++;
			},
			0,
			3,
			() => now,
		);
		for (let i = 0; i < 10; i++) {
			now += 100;
			t.request(`s${i}`);
		}
		expect(count).toBe(3);
	});

	test("finalise always lands, even when the interval has not elapsed", async () => {
		const seen: string[] = [];
		const t = new EditThrottle(async (text) => {
			seen.push(text);
		}, 60_000);
		t.request("interim");
		await t.finalise("final");
		expect(seen.at(-1)).toBe("final");
	});
});

describe("runBoardroom", () => {
	const twoOfficers: Officer[] = BOARD_ROSTER.slice(0, 2);

	test("produces exactly one message for the whole run", async () => {
		let sends = 0;
		const edits: string[] = [];
		const result = await runBoardroom(
			"Ship the bridge?",
			{
				askOfficer: async (o) => `${o.name} says yes`,
				askVerdict: async () => "Ship it.",
				sendMessage: async () => {
					sends++;
				},
				editMessage: async (t) => {
					edits.push(t);
				},
			},
			{ roster: twoOfficers, intervalMs: 0 },
		);
		expect(sends).toBe(1);
		expect(result.verdict).toBe("Ship it.");
		expect(edits.at(-1)).toContain("*Verdict:* Ship it.");
	});

	test("one officer failing does not sink the run", async () => {
		const result = await runBoardroom(
			"topic",
			{
				askOfficer: async (o) => {
					if (o.code === "8TO") throw new Error("agent unavailable");
					return "fine";
				},
				askVerdict: async () => "Proceed.",
				sendMessage: async () => {},
				editMessage: async () => {},
			},
			{ roster: twoOfficers, intervalMs: 0 },
		);
		expect(result.rows.find((r) => r.officer.code === "8TO")?.status).toBe("failed");
		expect(result.rows.find((r) => r.officer.code === "8EO")?.status).toBe("done");
		expect(result.verdict).toBe("Proceed.");
	});

	test("an empty brief counts as failed rather than a silent success", async () => {
		const result = await runBoardroom(
			"topic",
			{
				askOfficer: async () => "   ",
				askVerdict: async () => "should not be called",
				sendMessage: async () => {},
				editMessage: async () => {},
			},
			{ roster: twoOfficers, intervalMs: 0 },
		);
		expect(result.rows.every((r) => r.status === "failed")).toBe(true);
		expect(result.verdict).toBe(""); // no officer reported, so no verdict is invented
	});

	test("slow officers time out and the message still finalises", async () => {
		const result = await runBoardroom(
			"topic",
			{
				askOfficer: (_o, _t, signal) =>
					new Promise((_res, rej) => {
						signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
					}),
				askVerdict: async () => "unused",
				sendMessage: async () => {},
				editMessage: async () => {},
			},
			{ roster: twoOfficers, timeoutMs: 30, intervalMs: 0 },
		);
		expect(result.timedOut).toBe(true);
		expect(result.rows.every((r) => r.status === "timeout")).toBe(true);
	});

	test("the verdict is clamped even when the chair rambles", async () => {
		const result = await runBoardroom(
			"topic",
			{
				askOfficer: async () => "yes",
				askVerdict: async () => "word ".repeat(120),
				sendMessage: async () => {},
				editMessage: async () => {},
			},
			{ roster: twoOfficers, intervalMs: 0 },
		);
		expect(result.verdict.split(" ").length).toBeLessThanOrEqual(MAX_VERDICT_WORDS + 1);
	});

	test("edits stay inside the Telegram budget for a full eight-officer run", async () => {
		const result = await runBoardroom(
			"topic",
			{
				askOfficer: async (o) => `${o.name} yes`,
				askVerdict: async () => "Ship.",
				sendMessage: async () => {},
				editMessage: async () => {},
			},
			{ intervalMs: 5000 },
		);
		expect(result.edits).toBeLessThanOrEqual(20);
	});
});
