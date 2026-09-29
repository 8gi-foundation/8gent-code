/**
 * THINKING TIME IS NOT SPEAKING TIME.
 *
 * James, watching a live Video Deliberation: "in the huddle, the 8gents get cut
 * off after only a few seconds speaking/presenting."
 *
 * The floor used to bound the SPEAKING phase with estimateReadingMs(text), a
 * guess capped at READING_MS_CEILING (20s), and it started that clock the
 * instant the model's WORDS arrived. But the words are not the voice. Between
 * them sits the whole Phase 1 pipeline: slide render, the stage_ready sync gate
 * (up to 3s), then a Supertonic subprocess. All of that was spent out of the
 * officer's speaking time, and the pipeline's own ffprobe measurement of how
 * long the narration actually runs was broadcast to the stage and never told to
 * the state machine. Two clocks, unreconciled, and the floor's always won.
 *
 * These tests drive the FloorMachine directly with a fake slow agent and a fake
 * pipeline, so they assert the protocol rather than the model or the TTS.
 *
 * The two directions that matter:
 *   - a slow-but-HEALTHY turn must be allowed to finish (the defect)
 *   - a genuinely HUNG turn must still be cut (the guarantee that must survive
 *     the fix, or the fix is just a deadlock with better manners)
 */

import { describe, expect, it } from "bun:test";
import {
	CHAIR_HUMAN_ID,
	FloorMachine,
	type HuddleOpenConfig,
	type HuddleOutFrame,
	READING_MS_FLOOR,
	SPEAK_GRACE_MS,
} from "../floor";

/** The provisional window the old code gave every turn: the reading estimate
 *  for a short reply, which floors at READING_MS_FLOOR. Anything that has to
 *  happen after this instant used to be too late. */
const OLD_WINDOW_MS = READING_MS_FLOOR + SPEAK_GRACE_MS;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
	m: FloorMachine;
	frames: HuddleOutFrame[];
	/** ms since open, so assertions read as "by when", not "at what timestamp". */
	at: () => number;
	releases: () => { turnId: string; reason: string; at: number }[];
}

/**
 * One officer in the ring, an agent chair, and a fake pipeline.
 *
 * `think` is how long the model takes to produce text; `narrate` is how long
 * after that the narration STARTS and how long it then RUNS. That split is the
 * whole subject of this file.
 */
function harness(opts: {
	think: number;
	/** null = the agent never answers (a genuinely hung turn). */
	text?: string | null;
	/** null = narration is never reported (no pipeline, or it failed). */
	narrate?: { startsAfter: number; durationMs: number } | null;
	prepareBudgetMs?: number;
	speakBudgetMs?: number;
	audioStartGraceMs?: number;
}): Harness {
	const frames: HuddleOutFrame[] = [];
	const openedAt = Date.now();
	const releases: { turnId: string; reason: string; at: number }[] = [];
	let machine: FloorMachine | null = null;

	const config: HuddleOpenConfig = {
		huddleId: "turn-budget-test",
		channelId: "chan-turn-budget",
		openedBy: "human:local",
		roster: ["human:local", "agent:8PO"],
		topic: "does the floor let an officer finish",
		chair: CHAIR_HUMAN_ID,
		chairMode: "agent", // keep the chair out of the way; the ring turn is under test
		maxRounds: 1,
		maxDurationMs: 120_000,
		prepareBudgetMs: opts.prepareBudgetMs ?? 300,
		speakBudgetMs: opts.speakBudgetMs ?? 30_000,
		audioStartGraceMs: opts.audioStartGraceMs ?? 0,
	};

	const m = new FloorMachine(config, {
		emit: (f) => {
			frames.push(f);
			if (f.type === "huddle:floor_released") {
				releases.push({ turnId: f.turnId, reason: f.reason, at: Date.now() - openedAt });
			}
		},
		prepareAgentTurn: async (_ctx) => {
			await sleep(opts.think);
			if (opts.text === null) await sleep(60_000); // never answers
			return opts.text ?? "A short considered point about the topic.";
		},
		// The fake Phase 1 pipeline. It reports the narration's MEASURED length
		// back to the floor exactly where huddle-stage.ts does: at the instant
		// playback starts, after the render and the sync gate and the synthesis.
		postTurnText: (ctx) => {
			const n = opts.narrate;
			if (!n) return;
			setTimeout(() => machine?.noteTurnAudio(ctx.turnId, n.durationMs), n.startsAfter);
		},
	});
	machine = m;

	return { m, frames, at: () => Date.now() - openedAt, releases: () => releases };
}

const firstRingRelease = (h: Harness) => h.releases()[0];

describe("a presenting officer is not cut off mid-sentence", () => {
	it(
		"holds the floor for the narration's MEASURED length, not the reading estimate",
		async () => {
			// Narration that starts promptly but runs LONGER than the estimate the
			// floor would have guessed. Old behaviour: released at OLD_WINDOW_MS with
			// the officer still talking.
			const h = harness({
				think: 50,
				narrate: { startsAfter: 150, durationMs: OLD_WINDOW_MS + 400 },
				audioStartGraceMs: 1_000,
			});
			h.m.open();

			// Still speaking at the moment the old code would have cut them off.
			await sleep(OLD_WINDOW_MS + 300);
			expect(firstRingRelease(h)).toBeUndefined();
			expect(h.m.getSnapshot().currentHolder).toBe("agent:8PO");

			// Then released normally once the narration has actually finished.
			await sleep(1_400);
			const rel = firstRingRelease(h);
			expect(rel?.reason).toBe("yielded");
			// The clock ran from the narration START, for the narration's LENGTH -
			// so the release lands past both, which is strictly later than the old
			// window could ever reach.
			expect(rel?.at).toBeGreaterThanOrEqual(150 + OLD_WINDOW_MS + 400);

			// The turn kept its text: it was allowed to finish, not truncated.
			const turn = h.m.getSnapshot().turns[0];
			expect(turn?.holder).toBe("agent:8PO");
			expect(turn?.text).toBeTruthy();
			h.m.close("human:local");
		},
		15_000,
	);

	it(
		"does not bill slide render, the stage gate and TTS synthesis to speaking time",
		async () => {
			// The live shape of the bug: the pipeline takes longer to produce audio
			// than the reading estimate allowed, so the floor released BEFORE the
			// first word was ever audible and the officer's report arrived stale.
			const startsAfter = OLD_WINDOW_MS + 700;
			const h = harness({
				think: 50,
				narrate: { startsAfter, durationMs: 400 },
				audioStartGraceMs: OLD_WINDOW_MS + 2_500,
			});
			h.m.open();

			await sleep(startsAfter - 300);
			// Old behaviour: already released, holder null, narration about to be
			// reported against a turn that no longer exists.
			expect(firstRingRelease(h)).toBeUndefined();
			expect(h.m.getSnapshot().currentHolder).toBe("agent:8PO");

			await sleep(1_400);
			const rel = firstRingRelease(h);
			expect(rel?.reason).toBe("yielded");
			// Released on the audio, not on the grace: the grace only ever bounds
			// the WAIT, it never becomes the speaking window itself.
			expect(rel?.at).toBeGreaterThanOrEqual(startsAfter + 400);
			expect(rel?.at).toBeLessThan(startsAfter + 400 + 1_200);
			h.m.close("human:local");
		},
		15_000,
	);

	it("caps an absurd reported duration at speakBudgetMs", async () => {
		const h = harness({
			think: 20,
			narrate: { startsAfter: 60, durationMs: 900_000 }, // a broken probe
			speakBudgetMs: 400,
			audioStartGraceMs: 1_000,
		});
		h.m.open();
		await sleep(1_400);
		const rel = firstRingRelease(h);
		expect(rel?.reason).toBe("yielded");
		expect(rel?.at).toBeLessThan(1_400);
		h.m.close("human:local");
	}, 15_000);
});

describe("the cut-off guarantees that must survive the fix", () => {
	it("still cuts a genuinely hung turn at the prepare deadline", async () => {
		// The model never answers. No narration is ever reported, so none of the
		// new budgets can be reached - the thinking deadline is what fires.
		const h = harness({ think: 10, text: null, narrate: null, prepareBudgetMs: 200 });
		h.m.open();
		await sleep(700);
		const rel = firstRingRelease(h);
		expect(rel?.reason).toBe("deadline");
		expect(rel?.at).toBeLessThan(650);
		expect(h.m.getSnapshot().turns[0]?.text).toBeUndefined();
		h.m.close("human:local");
	}, 15_000);

	it(
		"still releases when narration is never reported, falling back to the estimate",
		async () => {
			// A pipeline that produced text but no audio at all (TTS missing, render
			// threw). The floor must not wait out speakBudgetMs for a report that is
			// never coming.
			const h = harness({ think: 30, narrate: null, audioStartGraceMs: 0 });
			h.m.open();
			await sleep(OLD_WINDOW_MS + 800);
			const rel = firstRingRelease(h);
			expect(rel?.reason).toBe("yielded");
			expect(rel?.at).toBeLessThan(OLD_WINDOW_MS + 800);
			h.m.close("human:local");
		},
		15_000,
	);

	it("still lets a human cut in mid-narration, and gives them the floor", async () => {
		const h = harness({
			think: 30,
			narrate: { startsAfter: 100, durationMs: 20_000 },
			audioStartGraceMs: 1_000,
		});
		h.m.open();
		await sleep(400);

		const held = h.m.getSnapshot().currentTurnId as string;
		expect(h.m.getSnapshot().currentHolder).toBe("agent:8PO");
		expect(h.m.cut("human:local", held)).toBe("ok");

		const rel = firstRingRelease(h);
		expect(rel?.reason).toBe("cut");
		// A cut hands the floor straight to the cutter as an interjection - a
		// generous speaking budget must never make a human wait for it.
		expect(h.m.getSnapshot().currentHolder).toBe("human:local");
		h.m.close("human:local");
	}, 15_000);

	it("still closes immediately mid-narration when the human hits stop", async () => {
		const h = harness({
			think: 30,
			narrate: { startsAfter: 100, durationMs: 20_000 },
			audioStartGraceMs: 1_000,
		});
		h.m.open();
		await sleep(400);
		expect(h.m.getSnapshot().currentHolder).toBe("agent:8PO");

		expect(h.m.close("human:local")).toBe("ok");
		expect(h.m.getSnapshot().phase).toBe("closed");
		expect(h.frames.some((f) => f.type === "huddle:closed")).toBe(true);
		// Stop means stop: it does not sit through the remaining 19 seconds of a
		// long, legitimately-budgeted narration.
		expect(firstRingRelease(h)?.reason).toBe("cut");
	}, 15_000);

	it("never lets a stale audio report reopen or extend a finished turn", async () => {
		const h = harness({ think: 20, narrate: null, audioStartGraceMs: 0 });
		h.m.open();
		await sleep(OLD_WINDOW_MS + 600);
		const finished = h.m.getSnapshot().turns[0];
		expect(finished).toBeTruthy();
		const releasesBefore = h.releases().length;

		h.m.noteTurnAudio(finished.turnId as string, 30_000);
		await sleep(120);
		expect(h.releases().length).toBe(releasesBefore);
		expect(h.m.getSnapshot().currentHolder).not.toBe("agent:8PO");
		h.m.close("human:local");
	}, 15_000);
});
