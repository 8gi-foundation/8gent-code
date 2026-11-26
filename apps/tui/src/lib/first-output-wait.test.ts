import { describe, expect, it } from "bun:test";
import { probeModelLoaded, startFirstOutputWait, waitStatusLine } from "./first-output-wait";

function fakeClock() {
	let fn: (() => void) | null = null;
	return {
		setInterval: (f: () => void) => {
			fn = f;
			return 1;
		},
		clearInterval: () => {
			fn = null;
		},
		tick: (n = 1) => {
			for (let i = 0; i < n; i++) fn?.();
		},
		running: () => fn !== null,
	};
}

describe("waitStatusLine", () => {
	it("says loading only when the server confirmed it", () => {
		expect(waitStatusLine("qwen3.5:9b", 34, true)).toBe("loading model qwen3.5:9b, 34 s");
		expect(waitStatusLine("qwen3.5:9b", 34, null)).toBe("waiting for qwen3.5:9b, 34 s");
		expect(waitStatusLine("qwen3.5:9b", 34, false)).toBe("waiting for qwen3.5:9b, 34 s");
	});
});

describe("startFirstOutputWait", () => {
	it("counts seconds live and says loading when the probe says not loaded", async () => {
		const clock = fakeClock();
		const lines: (string | null)[] = [];
		startFirstOutputWait({
			model: "m1",
			probe: async () => false,
			onLine: (l) => lines.push(l),
			...clock,
		});
		clock.tick(2);
		await Promise.resolve();
		await Promise.resolve();
		clock.tick(1);
		expect(lines[0]).toBe("waiting for m1, 1 s");
		expect(lines[1]).toBe("waiting for m1, 2 s");
		expect(lines.at(-1)).toBe("loading model m1, 3 s");
	});

	it("shows seconds and model only when it cannot tell", async () => {
		const clock = fakeClock();
		const lines: (string | null)[] = [];
		startFirstOutputWait({
			model: "m1",
			probe: async () => null,
			onLine: (l) => lines.push(l),
			...clock,
		});
		clock.tick(3);
		await Promise.resolve();
		expect(lines.filter((l) => l?.includes("loading"))).toEqual([]);
		expect(lines.at(-1)).toContain("waiting for m1");
	});

	it("progress clears the line and stop ends the clock", () => {
		const clock = fakeClock();
		const lines: (string | null)[] = [];
		const w = startFirstOutputWait({ model: "m1", onLine: (l) => lines.push(l), ...clock });
		clock.tick(5);
		w.touch();
		expect(lines.at(-1)).toBeNull();
		w.stop();
		expect(clock.running()).toBe(false);
	});
});

describe("probeModelLoaded", () => {
	const reply =
		(body: unknown, ok = true) =>
		async () =>
			({ ok, json: async () => body }) as unknown as Response;
	it("reads /api/ps", async () => {
		expect(
			await probeModelLoaded("http://h:1/", "m1", reply({ models: [{ name: "m1:latest" }] })),
		).toBe(true);
		expect(
			await probeModelLoaded("http://h:1", "m2", reply({ models: [{ name: "m1:latest" }] })),
		).toBe(false);
	});
	it("returns null when it cannot tell", async () => {
		expect(await probeModelLoaded("http://h:1", "m", reply({}, false))).toBeNull();
		expect(
			await probeModelLoaded("http://h:1", "m", async () => {
				throw new Error("down");
			}),
		).toBeNull();
	});
});
