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
		expect(detectBuildIntent("scaffold a new react component library")).not.toBeNull();
		expect(detectBuildIntent("generate a sitemap xml for the marketing site")).not.toBeNull();
		expect(detectBuildIntent("rebuild the dashboard with a dark theme")).not.toBeNull();
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
