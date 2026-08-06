/**
 * Officer reply-quality invariants.
 *
 * These are the properties that were measured broken against the live local
 * models on 2026-08-06 and are cheap to keep from regressing: the officer's
 * persona and the capability truth must be IN the prompt, the marker rule must
 * state its negative case, and a refusal must never ship the work it refused.
 */
import { describe, expect, test } from "bun:test";
import {
	buildTurnPrompt,
	refusesInProse,
	stripReasoning,
	tableSystemPrompt,
} from "../../daemon/table-routes";

const KAREN = {
	name: "Karen",
	role: "security",
	systemPrompt: "You are Karen, the security officer. Assume the input is hostile.",
};

describe("tableSystemPrompt", () => {
	test("carries the officer's own persona verbatim", () => {
		expect(tableSystemPrompt(KAREN)).toContain(KAREN.systemPrompt);
	});

	test("states the capability truth, not the coding-agent tool catalog", () => {
		const p = tableSystemPrompt(KAREN);
		expect(p).toContain("CANNOT run commands");
		// The generic agent prompt advertises these; a Table officer has none.
		expect(p).not.toContain("write_file");
		expect(p).not.toContain("run_command");
	});

	test("bans fabricated completion", () => {
		expect(tableSystemPrompt(KAREN)).toContain("fabricated completion");
	});

	test("asks for speakable output - huddle replies are read aloud", () => {
		const p = tableSystemPrompt(KAREN);
		expect(p).toContain("SPOKEN ALOUD");
		expect(p).toContain("no bullet lists");
	});

	test("states the NO-marker case as well as the marker case", () => {
		const p = tableSystemPrompt(KAREN);
		expect(p).toContain("[[TASK");
		expect(p).toContain("NO marker");
	});

	test("tells a refusing officer not to attach a marker", () => {
		expect(tableSystemPrompt(KAREN)).toContain("Never attach a");
	});
});

describe("buildTurnPrompt", () => {
	const envelope = JSON.stringify({ role: "channel_message", text: "hi" });

	test("never injects PLAN scaffolding", () => {
		const p = buildTurnPrompt({ memory: "", roundSoFar: [], envelope });
		expect(p).not.toContain("PLAN:");
	});

	test("carries the channel message as the authority", () => {
		const p = buildTurnPrompt({ memory: "", roundSoFar: [], envelope });
		expect(p).toContain(`CHANNEL_MESSAGE = ${envelope}`);
	});

	test("omits ROUND_SO_FAR entirely when the officer speaks first", () => {
		const p = buildTurnPrompt({ memory: "", roundSoFar: [], envelope });
		expect(p).not.toContain("ROUND_SO_FAR");
	});

	test("tells a later speaker to NAME the colleague it builds on", () => {
		const p = buildTurnPrompt({
			memory: "",
			roundSoFar: ["Karen (8SO) said: bind a token to the handshake."],
			envelope,
		});
		expect(p).toContain("ROUND_SO_FAR");
		expect(p).toContain("NAMING the colleague");
	});

	test("demotes memory to background, below the current message", () => {
		const p = buildTurnPrompt({ memory: "old note", roundSoFar: [], envelope });
		expect(p).toContain("BACKGROUND ONLY");
		expect(p.indexOf("OFFICER_MEMORY")).toBeLessThan(p.indexOf("CHANNEL_MESSAGE ="));
	});
});

describe("stripReasoning", () => {
	test("removes a closed think block, keeps the answer", () => {
		expect(stripReasoning("<think>First I decide which kind...</think>\n\nThe hook is privacy.")).toBe(
			"The hook is privacy.",
		);
	});

	test("drops an unterminated block - there is no answer after it", () => {
		// Verbatim shape from minicpm5 on ollama, 2026-08-06.
		expect(stripReasoning("<think>The user has provided:\n1. notes\n2. history")).toBe("");
	});

	test("removes a 'Thinking Process:' preamble", () => {
		expect(stripReasoning("Thinking Process: weigh the options.\n\nShip threading first.")).toBe(
			"Ship threading first.",
		);
	});

	test("leaves a normal reply untouched", () => {
		const ok = "Yes. Two officers writing it in the same round will lose one of the updates.";
		expect(stripReasoning(ok)).toBe(ok);
	});
});

describe("refusesInProse", () => {
	test("catches the measured live refusals", () => {
		// Verbatim from the 2026-08-06 bench, ornith-1.0-9b as 8SO.
		expect(refusesInProse("I'm not going to sign off on that kind of shared-history mutation")).toBe(true);
		expect(refusesInProse("Hard no on this. A force push to main will destroy work.")).toBe(true);
		expect(refusesInProse("I won't do this. Force-pushing to main is a shared-resource risk.")).toBe(true);
		expect(refusesInProse("I will not push that.")).toBe(true);
	});

	test("does not fire on an officer merely DISCUSSING the risk", () => {
		expect(refusesInProse("Force-pushing to main would destroy other people's work.")).toBe(false);
		expect(refusesInProse("Renaming it and updating the imports that reference it.")).toBe(false);
		expect(refusesInProse("There is no reason not to do it now.")).toBe(false);
	});
});
