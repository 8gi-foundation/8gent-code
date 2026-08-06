/**
 * Zen-gen: deterministic beat segmentation and visual selection (spec 6.2-6.3).
 *
 * The claim under test is the one James cares about: "almost zero tokens".
 * These are all PURE functions of whisper's segment list. If any of them ever
 * needs a model, this file stops passing for the right reason.
 */

import { describe, expect, it } from "bun:test";
import {
	BEAT_HARD_CAP_MS,
	BEAT_MERGE_FLOOR_MS,
	extractBullets,
	extractHeading,
	extractMetric,
	parseWhisperJson,
	segmentBeats,
	selectLayout,
	specForBeat,
	zenSlides,
	type Segment,
} from "../zen";
import { validateSlideSpec } from "../slide-spec";

const seg = (t0: number, t1: number, text: string): Segment => ({ t0, t1, text });

describe("segmentBeats", () => {
	it("returns nothing for no usable input", () => {
		expect(segmentBeats([])).toEqual([]);
		expect(segmentBeats([seg(0, 1000, "   ")])).toEqual([]);
	});

	it("is a pure function of the segments", () => {
		const segments = [seg(0, 5000, "So here is the thing."), seg(5000, 12000, "It works end to end."), seg(12000, 20000, "Next we ship it.")];
		expect(segmentBeats(segments)).toEqual(segmentBeats(segments));
	});

	it("R1 closes a beat at the 20s hard cap", () => {
		const segments = Array.from({ length: 10 }, (_, i) => seg(i * 4000, (i + 1) * 4000, `part ${i} continues on`));
		for (const beat of segmentBeats(segments)) {
			expect(beat.t1 - beat.t0).toBeLessThanOrEqual(BEAT_HARD_CAP_MS + 4000);
		}
	});

	it("R2 closes on a sentence end once past 6s", () => {
		const beats = segmentBeats([seg(0, 7000, "This is a complete sentence."), seg(7000, 14000, "And this is another one.")]);
		expect(beats.length).toBe(2);
	});

	it("R2 does NOT close on a sentence end before 6s", () => {
		const beats = segmentBeats([seg(0, 2000, "Short."), seg(2000, 9000, "Then a much longer stretch of talking here.")]);
		expect(beats.length).toBe(1);
	});

	it("R3 closes before a discourse marker once past 4s", () => {
		const beats = segmentBeats([seg(0, 5000, "we built the stage today"), seg(5000, 11000, "Next we wire the daemon in")]);
		expect(beats.length).toBe(2);
		expect(beats[1].text).toStartWith("Next");
	});

	it("R4 closes on a long pause once past 4s", () => {
		const beats = segmentBeats([seg(0, 5000, "the floor machine holds"), seg(6500, 12000, "and the deck bakes after")]);
		expect(beats.length).toBe(2);
	});

	it("merges a too-short beat forward into its successor", () => {
		const beats = segmentBeats([seg(0, 1200, "Hi."), seg(1200, 9000, "Now the real content arrives here.")]);
		expect(beats.length).toBe(1);
		expect(beats[0].text).toContain("Hi.");
		expect(beats[0].text).toContain("real content");
	});

	it("merges a trailing short beat backward, never dropping it", () => {
		const beats = segmentBeats([
			seg(0, 8000, "The first full thought is here."),
			seg(8000, 16000, "The second full thought is here."),
			seg(16000, 17000, "Right."),
		]);
		expect(beats.every((b) => b.t1 - b.t0 >= BEAT_MERGE_FLOOR_MS)).toBe(true);
		expect(beats.map((b) => b.text).join(" ")).toContain("Right.");
	});

	it("never loses text", () => {
		const segments = [seg(0, 5000, "alpha beta"), seg(5200, 11000, "gamma delta"), seg(11000, 14000, "epsilon zeta")];
		const joined = segmentBeats(segments).map((b) => b.text).join(" ");
		for (const word of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]) expect(joined).toContain(word);
	});
});

describe("selectLayout", () => {
	it("picks metric on a number with a unit", () => {
		expect(selectLayout("we cut it to 40 percent of the time")).toBe("metric");
	});
	it("picks compare on a comparison marker", () => {
		expect(selectLayout("the live stage versus the baked deck")).toBe("compare");
	});
	it("picks code on a command", () => {
		expect(selectLayout("just run bun test and see")).toBe("code");
	});
	it("picks close on a closing marker", () => {
		expect(selectLayout("bottom line, we ship tomorrow")).toBe("close");
	});
	it("falls back to bullets", () => {
		expect(selectLayout("nothing in particular about this one")).toBe("bullets");
	});
	it("prefers the highest-weight matching rule", () => {
		// Contains both a metric pattern (10) and a compare pattern (8).
		expect(selectLayout("40 percent faster compared to before")).toBe("metric");
	});
	it("is deterministic", () => {
		const t = "we went from 10ms to 2ms compared to last week";
		expect(selectLayout(t)).toBe(selectLayout(t));
	});
});

describe("extractHeading", () => {
	it("strips stacked leading fillers", () => {
		expect(extractHeading("so, um, basically the stage is live now")).toBe("The stage is live now");
	});
	it("caps at six words", () => {
		expect(extractHeading("one two three four five six seven eight").split(/\s+/).length).toBeLessThanOrEqual(6);
	});
	it("stops at the first clause boundary", () => {
		expect(extractHeading("the deck bakes fine, but the stage needs work")).toBe("The deck bakes fine");
	});
	it("never returns empty", () => {
		expect(extractHeading("so um uh").length).toBeGreaterThan(0);
	});
});

describe("extractBullets", () => {
	it("prefers fragments with digits", () => {
		const bullets = extractBullets("we shipped the thing; it took 3 days; people liked it");
		expect(bullets.some((b) => b.includes("3 days"))).toBe(true);
	});
	it("returns at most three, in original order", () => {
		const bullets = extractBullets("alpha one; beta two; gamma three; delta four; epsilon five");
		expect(bullets.length).toBeLessThanOrEqual(3);
	});
	it("is deterministic", () => {
		const t = "first thing here; second thing here; third thing here";
		expect(extractBullets(t)).toEqual(extractBullets(t));
	});
});

describe("extractMetric", () => {
	it("takes the first unit-bearing number as the value", () => {
		expect(extractMetric("we hit 40 percent coverage today")?.value).toBe("40percent");
	});
	it("takes the following words as the label", () => {
		expect(extractMetric("we hit 40 percent coverage on the suite")?.label).toContain("coverage");
	});
	it("returns null when there is no metric", () => {
		expect(extractMetric("nothing numeric here at all")).toBeNull();
	});
});

describe("specForBeat", () => {
	it("always produces a spec that passes validation", () => {
		const texts = [
			"so here is the thing we built today and it works",
			"we cut latency to 200 ms across the board",
			"the live stage versus the baked deck is the choice",
			"first we render, then we narrate, after that we bake",
			"run bun test packages/table to see it pass",
			"bottom line, it is ready to demo",
			"",
			"um",
		];
		for (const text of texts) {
			const spec = specForBeat({ t0: 0, t1: 8000, text, segments: [] });
			const result = validateSlideSpec(spec as unknown);
			expect(result.ok, `"${text}" produced an invalid spec: ${result.reason}`).toBe(true);
		}
	});

	it("is a pure function of the beat", () => {
		const beat = { t0: 0, t1: 9000, text: "we cut it to 200 ms across the board", segments: [] };
		expect(specForBeat(beat)).toEqual(specForBeat(beat));
	});

	it("falls back to bullets when a layout's payload cannot be extracted", () => {
		// Matches the compare rule but has nothing on the left of "versus".
		expect(specForBeat({ t0: 0, t1: 8000, text: "versus", segments: [] }).layout).not.toBe("compare");
	});
});

describe("zenSlides", () => {
	it("keys every slide to whisper's own timestamps", () => {
		const segments = [seg(0, 7000, "So here is the thing."), seg(7000, 15000, "It runs end to end now.")];
		const slides = zenSlides(segments);
		expect(slides.length).toBeGreaterThan(0);
		expect(slides[0].t0).toBe(0);
		expect(slides.at(-1)?.t1).toBe(15000);
		// Contiguous: no gap, no overlap - sync is exact by construction.
		for (let i = 1; i < slides.length; i++) expect(slides[i].t0).toBe(slides[i - 1].t1);
	});

	it("costs zero LLM calls (structural: the module imports no client)", async () => {
		const source = await Bun.file(new URL("../zen.ts", import.meta.url)).text();
		expect(source).not.toContain("fetch(");
		expect(source).not.toContain("AgentPool");
		expect(source).not.toContain("chat(");
	});
});

describe("parseWhisperJson", () => {
	it("reads whisper.cpp offsets as milliseconds", () => {
		const raw = JSON.stringify({ transcription: [{ offsets: { from: 0, to: 2500 }, text: " hello" }] });
		expect(parseWhisperJson(raw)).toEqual([{ t0: 0, t1: 2500, text: " hello" }]);
	});

	it("reads OpenAI-format segments as seconds", () => {
		const raw = JSON.stringify({ segments: [{ start: 0, end: 2.5, text: "hello" }] });
		expect(parseWhisperJson(raw)).toEqual([{ t0: 0, t1: 2500, text: "hello" }]);
	});

	it("returns nothing for an unrecognised shape rather than guessing", () => {
		expect(parseWhisperJson(JSON.stringify({ text: "hello" }))).toEqual([]);
	});
});
