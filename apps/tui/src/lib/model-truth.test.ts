/**
 * #3102: after a reroute the screen names the model that ran the turn.
 *
 * The case from pilot run 2026-09-30_053936: launched with
 * `--provider 8gent --model eight-1.0-q3:14b`, which is not installed. The
 * agent rerouted to qwen3.8:27b-mlx and self-corrected its config.model,
 * while the strip, the status bar and PROVIDERS kept saying eight-1.0-q3:14b.
 */

import { describe, expect, test } from "bun:test";
import { deriveProviders } from "./activity-rail-derivation.js";
import { askedNote, modelOnScreen, providerOnScreen, routeOnScreen } from "./model-truth.js";

const ASKED = "eight-1.0-q3:14b";
const RAN = "qwen3.8:27b-mlx";

describe("modelOnScreen", () => {
	test("no reroute: the asked model, with no note", () => {
		expect(modelOnScreen({ asked: ASKED, built: ASKED, live: ASKED })).toEqual({ ran: ASKED });
	});

	test("during the rerouted turn the event names the model before config.model moves", () => {
		expect(modelOnScreen({ asked: ASKED, built: ASKED, live: ASKED, routed: RAN })).toEqual({
			ran: RAN,
			asked: ASKED,
		});
	});

	test("after the turn the self-corrected live config names it", () => {
		expect(modelOnScreen({ asked: ASKED, built: ASKED, live: RAN })).toEqual({
			ran: RAN,
			asked: ASKED,
		});
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

// Moira's review of #3106: after the reroute the PROVIDERS row still said
// "8gent" beside qwen3.8:27b-mlx, though the turn went to the Ollama host.
// The reroute event carries the provider that ran; the label follows it.
describe("providerOnScreen", () => {
	test("the routed provider names the rerouted model", () => {
		expect(
			providerOnScreen({ asked: "8gent", routed: { model: RAN, provider: "ollama" }, ran: RAN }),
		).toBe("ollama");
	});

	test("no reroute: the configured provider", () => {
		expect(providerOnScreen({ asked: "8gent", ran: ASKED })).toBe("8gent");
	});

	test("a stale reroute for another model does not relabel the one on screen", () => {
		// The user switched model: modelOnScreen shows the asked one, so the provider must be the asked one too.
		expect(
			providerOnScreen({
				asked: "ollama",
				routed: { model: RAN, provider: "lmstudio" },
				ran: "llama3.2:3b",
			}),
		).toBe("ollama");
	});

	test("an event with no provider leaves the configured one", () => {
		expect(
			providerOnScreen({ asked: "8gent", routed: { model: RAN, provider: "" }, ran: RAN }),
		).toBe("8gent");
	});
});

describe("routeOnScreen (what app.tsx renders into PROVIDERS)", () => {
	const base = { asked: ASKED, askedProvider: "8gent", built: ASKED, live: ASKED };

	test("the pilot case: 8gent asked, qwen3.8:27b-mlx served by ollama", () => {
		const route = routeOnScreen({ ...base, routed: { model: RAN, provider: "ollama" } });
		expect(route).toEqual({ ran: RAN, asked: ASKED, provider: "ollama" });
		expect(
			deriveProviders({
				primary: { name: `${route.provider}:${route.ran}`, asked: route.asked },
				fallback: null,
				offline: null,
			})[0].name,
		).toBe(`ollama:${RAN}`);
	});

	test("no reroute: the configured provider and model", () => {
		expect(routeOnScreen(base)).toEqual({ ran: ASKED, provider: "8gent" });
	});

	test("model switched since the reroute: back to the configured route", () => {
		expect(
			routeOnScreen({
				...base,
				asked: "llama3.2:3b",
				askedProvider: "ollama",
				routed: { model: RAN, provider: "lmstudio" },
			}),
		).toEqual({ ran: "llama3.2:3b", provider: "ollama" });
	});
});
