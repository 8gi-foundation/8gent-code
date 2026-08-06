/**
 * Tests for the voice-complete lifecycle (issue #2759 step 3).
 *
 * The properties that matter most, tested hardest:
 *   1. Safety guards — a lifecycle verb (approve / dispatch / merge) said in a
 *      phase where it has no meaning must be a narrated no-op, never a real
 *      dispatch or merge.
 *   2. Full hands-free loop — dictate -> plan -> approve -> steer -> merge with
 *      zero keyboard, driven only by voice commands and surface signals.
 *   3. Every transition narrates — a keyboard-free, screen-free user is never
 *      left in silence; `speak` is always non-empty.
 */

import { describe, expect, test } from "bun:test";
import { type VoiceCommand, parseVoiceCommand } from "./voice-grammar";
import {
	type LifecyclePhase,
	VoiceLifecycle,
	initialLifecycleState,
	reduceLifecycleSignal,
	reduceVoiceCommand,
} from "./voice-lifecycle";

/** Build a command the way a real surface does: parse a raw transcript. */
function say(raw: string): VoiceCommand {
	return parseVoiceCommand(raw);
}

describe("initial state", () => {
	test("starts idle with an empty buffer", () => {
		const s = initialLifecycleState();
		expect(s.phase).toBe("idle");
		expect(s.buffer).toBe("");
		expect(s.lastSpoken).toBe("");
	});
});

describe("dictation composes the task buffer", () => {
	test("first dictation moves idle -> composing", () => {
		const t = reduceVoiceCommand(initialLifecycleState(), say("add a retry to the fetch helper"));
		expect(t.from).toBe("idle");
		expect(t.to).toBe("composing");
		expect(t.state.buffer).toBe("add a retry to the fetch helper");
		expect(t.effect).toBe("none");
	});

	test("further dictation appends to the buffer", () => {
		let s = initialLifecycleState();
		s = reduceVoiceCommand(s, say("add a retry")).state;
		const t = reduceVoiceCommand(s, say("with backoff"));
		expect(t.state.buffer).toBe("add a retry with backoff");
		expect(t.to).toBe("composing");
	});

	test("undo removes the last dictated word", () => {
		let s = initialLifecycleState();
		s = reduceVoiceCommand(s, say("add a retry loop")).state;
		const t = reduceVoiceCommand(s, say("undo"));
		expect(t.state.buffer).toBe("add a retry");
		expect(t.to).toBe("composing");
	});

	test("undo on the last word returns to idle", () => {
		let s = initialLifecycleState();
		s = reduceVoiceCommand(s, say("retry")).state;
		const t = reduceVoiceCommand(s, say("undo"));
		expect(t.state.buffer).toBe("");
		expect(t.to).toBe("idle");
	});

	test("scratch clears the buffer and returns to idle", () => {
		let s = initialLifecycleState();
		s = reduceVoiceCommand(s, say("some long task")).state;
		const t = reduceVoiceCommand(s, say("scratch that"));
		expect(t.effect).toBe("clear_input");
		expect(t.state.buffer).toBe("");
		expect(t.to).toBe("idle");
	});
});

describe("submit requires content and requests a plan", () => {
	test("submit with an empty buffer is rejected", () => {
		// Force an empty composing state (undo to empty stays idle, so build it directly).
		const t = reduceVoiceCommand(
			{ phase: "composing", buffer: "   ", lastSpoken: "" },
			say("send it"),
		);
		expect(t.accepted).toBe(false);
		expect(t.effect).toBe("none");
		expect(t.to).toBe("composing");
	});

	test("submit with content requests a plan and moves to planning", () => {
		let s = initialLifecycleState();
		s = reduceVoiceCommand(s, say("write a parser")).state;
		const t = reduceVoiceCommand(s, say("submit"));
		expect(t.effect).toBe("request_plan");
		expect(t.to).toBe("planning");
		expect(t.state.buffer).toBe("write a parser");
	});
});

describe("plan lifecycle", () => {
	function toPlanReview() {
		let s = initialLifecycleState();
		s = reduceVoiceCommand(s, say("write a parser")).state;
		s = reduceVoiceCommand(s, say("submit")).state;
		s = reduceLifecycleSignal(s, "plan_ready").state;
		return s;
	}

	test("plan_ready signal moves planning -> plan_review", () => {
		let s = initialLifecycleState();
		s = reduceVoiceCommand(s, say("write a parser")).state;
		s = reduceVoiceCommand(s, say("submit")).state;
		const t = reduceLifecycleSignal(s, "plan_ready");
		expect(t.from).toBe("planning");
		expect(t.to).toBe("plan_review");
	});

	test("approve dispatches the plan", () => {
		const t = reduceVoiceCommand(toPlanReview(), say("approve"));
		expect(t.effect).toBe("dispatch");
		expect(t.to).toBe("working");
	});

	test("dispatch verb also dispatches", () => {
		const t = reduceVoiceCommand(toPlanReview(), say("dispatch"));
		expect(t.effect).toBe("dispatch");
		expect(t.to).toBe("working");
	});

	test("reject keeps the task and returns to composing", () => {
		const t = reduceVoiceCommand(toPlanReview(), say("reject"));
		expect(t.to).toBe("composing");
		expect(t.state.buffer).toBe("write a parser");
		expect(t.effect).toBe("none");
	});

	test("steer at plan review revises the plan and carries the correction", () => {
		const t = reduceVoiceCommand(toPlanReview(), say("steer use the streaming API"));
		expect(t.effect).toBe("revise_plan");
		expect(t.arg).toBe("use the streaming api");
		expect(t.to).toBe("plan_review");
	});

	test("stop at plan review aborts to idle and clears the buffer", () => {
		const t = reduceVoiceCommand(toPlanReview(), say("stop"));
		expect(t.effect).toBe("abort");
		expect(t.to).toBe("idle");
		expect(t.state.buffer).toBe("");
	});
});

describe("working lifecycle", () => {
	function toWorking() {
		let s = initialLifecycleState();
		s = reduceVoiceCommand(s, say("write a parser")).state;
		s = reduceVoiceCommand(s, say("submit")).state;
		s = reduceLifecycleSignal(s, "plan_ready").state;
		s = reduceVoiceCommand(s, say("approve")).state;
		return s;
	}

	test("steer mid-run emits a steer effect with the correction", () => {
		const t = reduceVoiceCommand(toWorking(), say("steer use tabs not spaces"));
		expect(t.effect).toBe("steer");
		expect(t.arg).toBe("use tabs not spaces");
		expect(t.to).toBe("working");
	});

	test("stop aborts the run to idle", () => {
		const t = reduceVoiceCommand(toWorking(), say("stop"));
		expect(t.effect).toBe("abort");
		expect(t.to).toBe("idle");
	});

	test("work_done moves working -> merge_review", () => {
		const t = reduceLifecycleSignal(toWorking(), "work_done");
		expect(t.to).toBe("merge_review");
		expect(t.effect).toBe("none");
	});

	test("work_failed returns to composing keeping the task", () => {
		const t = reduceLifecycleSignal(toWorking(), "work_failed");
		expect(t.to).toBe("composing");
		expect(t.state.buffer).toBe("write a parser");
	});
});

describe("merge lifecycle", () => {
	function toMergeReview() {
		let s = initialLifecycleState();
		s = reduceVoiceCommand(s, say("write a parser")).state;
		s = reduceVoiceCommand(s, say("submit")).state;
		s = reduceLifecycleSignal(s, "plan_ready").state;
		s = reduceVoiceCommand(s, say("approve")).state;
		s = reduceLifecycleSignal(s, "work_done").state;
		return s;
	}

	test("merge ships the work and returns to idle", () => {
		const t = reduceVoiceCommand(toMergeReview(), say("merge"));
		expect(t.effect).toBe("merge");
		expect(t.to).toBe("idle");
		expect(t.state.buffer).toBe("");
	});

	test("approve also merges at the merge gate", () => {
		const t = reduceVoiceCommand(toMergeReview(), say("approve"));
		expect(t.effect).toBe("merge");
		expect(t.to).toBe("idle");
	});

	test("reject discards without merging", () => {
		const t = reduceVoiceCommand(toMergeReview(), say("reject"));
		expect(t.effect).toBe("discard");
		expect(t.to).toBe("idle");
	});
});

describe("SAFETY: lifecycle verbs never fire in the wrong phase", () => {
	// The single most important property: a misheard or mistimed "merge" /
	// "dispatch" / "approve" must never perform the real action.
	const dangerous: { phase: LifecyclePhase; buffer: string; utter: string }[] = [
		{ phase: "idle", buffer: "", utter: "merge" },
		{ phase: "idle", buffer: "", utter: "dispatch" },
		{ phase: "idle", buffer: "", utter: "approve" },
		{ phase: "composing", buffer: "a task", utter: "merge" },
		{ phase: "composing", buffer: "a task", utter: "dispatch" },
		{ phase: "composing", buffer: "a task", utter: "approve" },
		{ phase: "planning", buffer: "a task", utter: "merge" },
		{ phase: "planning", buffer: "a task", utter: "approve" },
		{ phase: "plan_review", buffer: "a task", utter: "merge" },
		{ phase: "working", buffer: "a task", utter: "merge" },
		{ phase: "working", buffer: "a task", utter: "approve" },
		{ phase: "working", buffer: "a task", utter: "dispatch" },
	];

	for (const { phase, buffer, utter } of dangerous) {
		test(`"${utter}" is rejected in phase ${phase}`, () => {
			const t = reduceVoiceCommand({ phase, buffer, lastSpoken: "" }, say(utter));
			expect(t.accepted).toBe(false);
			expect(t.effect).toBe("none");
			expect(t.to).toBe(phase); // no phase change
			expect(t.speak.length).toBeGreaterThan(0); // but always narrated
		});
	}
});

describe("universal intents work in every phase", () => {
	const phases: LifecyclePhase[] = [
		"idle",
		"composing",
		"planning",
		"plan_review",
		"working",
		"merge_review",
	];

	test("help asks the surface to read the command list in any phase", () => {
		for (const phase of phases) {
			const t = reduceVoiceCommand({ phase, buffer: "x", lastSpoken: "" }, say("help"));
			expect(t.effect).toBe("speak_help");
			expect(t.to).toBe(phase);
		}
	});

	test("repeat re-speaks the last thing said without changing it", () => {
		const t = reduceVoiceCommand(
			{ phase: "working", buffer: "x", lastSpoken: "Steering: use tabs" },
			say("repeat"),
		);
		expect(t.effect).toBe("repeat");
		expect(t.speak).toBe("Steering: use tabs");
		// Crucial: repeat must not overwrite lastSpoken, or a second repeat loses it.
		expect(t.state.lastSpoken).toBe("Steering: use tabs");
	});

	test("cancel dismisses the interaction but keeps the buffer", () => {
		const t = reduceVoiceCommand(
			{ phase: "composing", buffer: "keep me", lastSpoken: "" },
			say("cancel"),
		);
		expect(t.to).toBe("composing");
		expect(t.state.buffer).toBe("keep me");
		expect(t.effect).toBe("none");
	});
});

describe("out-of-phase signals are ignored", () => {
	test("work_done while idle changes nothing", () => {
		const t = reduceLifecycleSignal(initialLifecycleState(), "work_done");
		expect(t.to).toBe("idle");
		expect(t.accepted).toBe(false);
	});

	test("plan_ready while working changes nothing", () => {
		const t = reduceLifecycleSignal(
			{ phase: "working", buffer: "x", lastSpoken: "" },
			"plan_ready",
		);
		expect(t.to).toBe("working");
		expect(t.accepted).toBe(false);
	});
});

describe("every transition narrates something", () => {
	// Accessibility contract: a keyboard-free, screen-free user is never left
	// guessing. Exhaustively assert speak is non-empty across a full loop and a
	// spread of rejects.
	test("speak is never empty across a complete hands-free loop", () => {
		const machine = new VoiceLifecycle();
		const utterances = ["build a login form", "submit", "approve", "steer add validation", "stop"];
		for (const u of utterances) {
			const t = machine.command(say(u));
			expect(t.speak.length).toBeGreaterThan(0);
		}
	});
});

describe("VoiceLifecycle wrapper drives the full loop end to end", () => {
	test("dictate -> plan -> approve -> steer -> done -> merge with zero keyboard", () => {
		const m = new VoiceLifecycle();
		expect(m.phase).toBe("idle");

		m.command(say("add rate limiting to the API"));
		expect(m.phase).toBe("composing");
		expect(m.buffer).toBe("add rate limiting to the api");

		m.command(say("submit"));
		expect(m.phase).toBe("planning");

		m.signal("plan_ready");
		expect(m.phase).toBe("plan_review");

		const dispatched = m.command(say("dispatch"));
		expect(dispatched.effect).toBe("dispatch");
		expect(m.phase).toBe("working");

		const steer = m.command(say("steer use a token bucket"));
		expect(steer.effect).toBe("steer");
		expect(steer.arg).toBe("use a token bucket");
		expect(m.phase).toBe("working");

		m.signal("work_done");
		expect(m.phase).toBe("merge_review");

		const merged = m.command(say("merge"));
		expect(merged.effect).toBe("merge");
		expect(m.phase).toBe("idle");
		expect(m.buffer).toBe("");
	});

	test("reset returns to a fresh idle session", () => {
		const m = new VoiceLifecycle();
		m.command(say("some task"));
		m.reset();
		expect(m.phase).toBe("idle");
		expect(m.buffer).toBe("");
	});
});
