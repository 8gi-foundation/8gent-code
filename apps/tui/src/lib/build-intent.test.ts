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
		expect(detectBuildIntent("create a migration that adds an index to users")).toBeNull();
	});
});
