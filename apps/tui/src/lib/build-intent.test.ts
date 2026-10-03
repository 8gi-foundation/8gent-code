/**
 * Tests for detectBuildIntent - the keyword auto-route guard. Precision
 * matters more than recall here: a false positive costs a multi-minute
 * pipeline run, so the negative cases are as important as the positives.
 */

import { describe, expect, test } from "bun:test";
import { detectBuildIntent } from "./build-intent";

describe("detectBuildIntent - fires on imperative build requests", () => {
	test("a plain build command", () => {
		const msg = "build me an animated 3D portfolio hero page";
		expect(detectBuildIntent(msg)).toBe(msg);
	});

	test("polite-request framing is stripped", () => {
		const msg = "can you create a landing page with a hero section";
		expect(detectBuildIntent(msg)).toBe(msg);
	});

	test("synonyms of build", () => {
		expect(detectBuildIntent("scaffold a portfolio site with a hero section")).not.toBeNull();
		expect(detectBuildIntent("generate an animated canvas visualisation of rain")).not.toBeNull();
		expect(detectBuildIntent("rebuild the dashboard with a dark theme")).not.toBeNull();
	});

	test("a web artifact for a small business still routes (#3323)", () => {
		expect(detectBuildIntent("make me a landing page for a coffee shop")).not.toBeNull();
		expect(detectBuildIntent("build a three.js particle demo")).not.toBeNull();
		expect(detectBuildIntent("create a single index.html snake game")).not.toBeNull();
	});

	test("make me X is a build", () => {
		expect(detectBuildIntent("make me a single-file 3D landing page")).not.toBeNull();
	});
});

describe("detectBuildIntent - stays out of the way", () => {
	test("informational questions never trigger", () => {
		expect(detectBuildIntent("how do I build a docker image for this app")).toBeNull();
		expect(detectBuildIntent("what is the best way to build a REST API")).toBeNull();
	});

	test("incidental use of the word build does not trigger", () => {
		expect(detectBuildIntent("the build is broken, can you take a look")).toBeNull();
	});

	test("'make sure' / 'make it' are not artifact builds", () => {
		expect(detectBuildIntent("make sure the tests pass before pushing")).toBeNull();
		expect(detectBuildIntent("make it faster if you can please")).toBeNull();
	});

	test("explicit slash commands are left alone", () => {
		expect(detectBuildIntent("/build a thing")).toBeNull();
	});

	test("terse messages do not trigger", () => {
		expect(detectBuildIntent("build")).toBeNull();
		expect(detectBuildIntent("hi there")).toBeNull();
	});

	test("a normal conversational message does not trigger", () => {
		expect(detectBuildIntent("thanks, that looks great, ship it")).toBeNull();
	});
});

describe("detectBuildIntent - repo tasks go to the agent, not the HTML pipeline (#3323)", () => {
	test("the l2-solo-deck pilot prompt is not routed", () => {
		const msg =
			"Make a short slide deck about the package in packages/decide. First write deck/outline.md, " +
			"then write deck/deck.md (Marp) from it, then run `ls deck` to show the files.";
		expect(detectBuildIntent(msg)).toBeNull();
	});

	test("make deck/outline.md and deck/deck.md (Marp) about packages/decide", () => {
		expect(
			detectBuildIntent("make deck/outline.md and deck/deck.md (Marp) about packages/decide, then run ls deck"),
		).toBeNull();
	});

	test("a repo path or non-html file extension is not routed", () => {
		expect(detectBuildIntent("make a deck at deck/deck.md")).toBeNull();
		expect(detectBuildIntent("create a landing page component in src/pages/Home.tsx")).toBeNull();
		expect(detectBuildIntent("make a README.md for the landing page project")).toBeNull();
	});

	test("a backtick command is not routed", () => {
		expect(detectBuildIntent("create src/foo.ts and run `bun test`")).toBeNull();
		expect(detectBuildIntent("build the site and then run `bun run build` to check it")).toBeNull();
	});

	test("a build verb with no web artifact is not routed", () => {
		expect(detectBuildIntent("make a short slide deck about the decide package")).toBeNull();
		expect(detectBuildIntent("scaffold a new react component library")).toBeNull();
		expect(detectBuildIntent("generate a sitemap xml for the marketing team")).toBeNull();
		expect(detectBuildIntent("generate a sitemap xml for the marketing site")).toBeNull();
		expect(detectBuildIntent("create a migration that adds an index to users")).toBeNull();
	});
});

describe("detectBuildIntent - edits to existing code go to the agent loop (#3325)", () => {
	const editAsks = [
		"make the login page use dark mode",
		"make the dashboard load faster",
		"create a PR for the dashboard changes",
		"build a demo of the new auth flow in the app",
		"create a site map for the docs",
		"build a react landing page with tailwind",
	];
	for (const msg of editAsks) {
		test(`not routed to /build: ${msg}`, () => {
			expect(detectBuildIntent(msg)).toBeNull();
		});
	}
});

describe("detectBuildIntent - /build stays reachable for new one-page web things (#3325)", () => {
	const newThings = [
		"make me a landing page for my bakery",
		"build a snake game",
		"create a portfolio website for a photographer",
		"build a 3d solar system in three.js",
		"make a 3D globe visualization",
		"build a game in index.html",
		"rebuild the dashboard with a dark theme",
	];
	for (const msg of newThings) {
		test(`routed to /build: ${msg}`, () => {
			expect(detectBuildIntent(msg)).toBe(msg);
		});
	}
});

describe("detectBuildIntent - the exact l2-solo-deck pilot prompt stays with the agent loop (#3325)", () => {
	// Verbatim from the Rishi pilot scenario l2-solo-deck. On main 818d48f7 it
	// was routed to /build, the engineer tried to emit an HTML file, and the
	// turn timed out at 900 s without writing deck/ (run 2026-10-02_221808).
	const pilotPrompt =
		"Make a short slide deck about the package in packages/decide. First read packages/decide to understand it. " +
		"Then write a 5 point outline to deck/outline.md. Then write the deck as Marp markdown to deck/deck.md, " +
		"with marp: true in the front matter and at least 5 slides separated by ---. " +
		"Then run `ls deck` and `wc -l deck/deck.md` and tell me what you made.";

	test("the verbatim pilot prompt is not routed", () => {
		expect(detectBuildIntent(pilotPrompt)).toBeNull();
	});

	test("the pilot prompt is not routed with polite framing either", () => {
		expect(detectBuildIntent(`can you ${pilotPrompt.charAt(0).toLowerCase()}${pilotPrompt.slice(1)}`)).toBeNull();
	});

	const namedFilesAndCommands = [
		"create notes/summary.md from the README and run `cat notes/summary.md`",
		"make a CHANGELOG.md entry for the dashboard fix and run `git diff`",
		"generate docs for the landing page in docs/landing.md",
		"build the demo page again and run `bun test` afterwards",
		"make the hero page title bigger in src/pages/hero.tsx",
	];
	for (const msg of namedFilesAndCommands) {
		test(`named files or commands stay with the agent: ${msg}`, () => {
			expect(detectBuildIntent(msg)).toBeNull();
		});
	}
});

describe("detectBuildIntent - genuinely new apps and games still reach /build (#3325)", () => {
	const newAppsAndGames = [
		"build a new pomodoro timer web app as a single page",
		"make me a tetris game",
		"create a breakout game with neon colours",
		"build an interactive 3d demo of the solar system",
		"make me a landing page for a dog walking business",
	];
	for (const msg of newAppsAndGames) {
		test(`routed to /build: ${msg}`, () => {
			expect(detectBuildIntent(msg)).toBe(msg);
		});
	}
});

describe("detectBuildIntent - long input cannot freeze the submit path (#3325)", () => {
	test("200 KB spaceless hyphenated input returns null in under 50 ms", () => {
		const msg = "build a landing page " + "a-".repeat(100000);
		const start = performance.now();
		const result = detectBuildIntent(msg);
		const elapsed = performance.now() - start;
		expect(result).toBeNull();
		expect(elapsed).toBeLessThan(50);
	});
});
