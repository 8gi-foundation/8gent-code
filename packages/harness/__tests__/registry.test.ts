/**
 * HarnessRegistry - the pluggable harness seam (part of #2797).
 *
 * Covers:
 *   - register + get + list round-trip
 *   - duplicate registration throws
 *   - get() with no name resolves DEFAULT_HARNESS ("8gent-local")
 *   - get() with an unknown name throws
 *   - createDefaultRegistry() ships with 8gent-local pre-registered
 */

import { describe, expect, it } from "bun:test";
import {
	DEFAULT_HARNESS,
	type Harness,
	HarnessRegistry,
	type StatusEvent,
	createDefaultRegistry,
} from "../index";

function fakeHarness(name: string): Harness {
	return {
		name,
		// biome-ignore lint/correctness/useYield: minimal fake, never iterated in these tests
		async *run(task): AsyncIterable<StatusEvent> {
			void task;
		},
	};
}

describe("HarnessRegistry", () => {
	it("registers a harness and gets it back by name", () => {
		const registry = new HarnessRegistry();
		const h = fakeHarness("test-harness");
		registry.register(h);
		expect(registry.get("test-harness")).toBe(h);
	});

	it("lists registered harness names in registration order", () => {
		const registry = new HarnessRegistry();
		registry.register(fakeHarness("alpha"));
		registry.register(fakeHarness("beta"));
		expect(registry.list()).toEqual(["alpha", "beta"]);
	});

	it("throws on duplicate registration", () => {
		const registry = new HarnessRegistry();
		registry.register(fakeHarness("dupe"));
		expect(() => registry.register(fakeHarness("dupe"))).toThrow(/dupe/);
	});

	it("resolves the default harness when no name is given", () => {
		const registry = new HarnessRegistry();
		const local = fakeHarness(DEFAULT_HARNESS);
		registry.register(local);
		expect(DEFAULT_HARNESS).toBe("8gent-local");
		expect(registry.get()).toBe(local);
	});

	it("throws for an unknown harness name", () => {
		const registry = new HarnessRegistry();
		expect(() => registry.get("no-such-harness")).toThrow(/no-such-harness/);
	});

	it("createDefaultRegistry pre-registers 8gent-local", () => {
		const registry = createDefaultRegistry();
		expect(registry.list()).toContain("8gent-local");
		expect(registry.get().name).toBe("8gent-local");
	});
});
