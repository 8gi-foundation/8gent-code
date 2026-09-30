/**
 * #3102: after a reroute the screen names the model that ran the turn.
 *
 * The case from pilot run 2026-09-30_053936: launched with
 * `--provider 8gent --model eight-1.0-q3:14b`, which is not installed. The
 * agent rerouted to qwen3.8:27b-mlx and self-corrected its config.model,
 * while the strip, the status bar and PROVIDERS kept saying eight-1.0-q3:14b.
 */

import { describe, expect, test } from "bun:test";
import { askedNote, modelOnScreen } from "./model-truth.js";

const ASKED = "eight-1.0-q3:14b";
const RAN = "qwen3.8:27b-mlx";

describe("modelOnScreen", () => {
	test("no reroute: the asked model, with no note", () => {
		expect(modelOnScreen({ asked: ASKED, built: ASKED, live: ASKED })).toEqual({ ran: ASKED });
	});

	test("during the rerouted turn the event names the model before config.model moves", () => {
		expect(modelOnScreen({ asked: ASKED, built: ASKED, live: ASKED, routed: RAN })).toEqual({ ran: RAN, asked: ASKED });
	});

	test("after the turn the self-corrected live config names it", () => {
		expect(modelOnScreen({ asked: ASKED, built: ASKED, live: RAN })).toEqual({ ran: RAN, asked: ASKED });
	});

	test("an agent built for another model says nothing about the next turn", () => {
		// The user switched model: the old agent is dropped and rebuilt before any turn.
		expect(modelOnScreen({ asked: "llama3.2:3b", built: ASKED, live: RAN, routed: RAN })).toEqual({
			ran: "llama3.2:3b",
		});
	});

	test("no agent yet: the asked model", () => {
		expect(modelOnScreen({ asked: ASKED })).toEqual({ ran: ASKED });
	});

	test("no model configured: nothing invented", () => {
		expect(modelOnScreen({ asked: "", live: RAN })).toEqual({ ran: "" });
	});

	test("the note reads as asked, not as a second model that ran", () => {
		expect(askedNote(ASKED)).toBe("(asked eight-1.0-q3:14b)");
	});
});
