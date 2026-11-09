/**
 * Pilot break 13: Esc then Ctrl+C mid-turn on a slow model froze the TUI for
 * about 78 s, because quitting only unmounted Ink and left the turn running.
 * Quitting must stop the turn first, unmount, and arm a hard exit that fires
 * even when the agent still holds the event loop.
 */
import { describe, expect, test } from "bun:test";
import { QUIT_GRACE_MS, quitNow } from "../lib/quit";

function harness() {
	const log: string[] = [];
	const scheduled: Array<{ fn: () => void; ms: number }> = [];
	return {
		log,
		scheduled,
		deps: {
			hardExit: (c: number) => log.push(`exit:${c}`),
			schedule: (fn: () => void, ms: number) => {
				scheduled.push({ fn, ms });
			},
		},
	};
}

describe("quitNow", () => {
	test("aborts the turn, then unmounts, then arms the hard exit", () => {
		const h = harness();
		quitNow({
			...h.deps,
			abortAll: () => h.log.push("abort"),
			unmount: () => h.log.push("unmount"),
		});
		expect(h.log).toEqual(["abort", "unmount"]);
		expect(h.scheduled).toHaveLength(1);
		expect(h.scheduled[0]!.ms).toBe(QUIT_GRACE_MS);
		h.scheduled[0]!.fn();
		expect(h.log).toEqual(["abort", "unmount", "exit:0"]);
	});

	test("a throwing abort still unmounts and still arms the exit", () => {
		const h = harness();
		quitNow({
			...h.deps,
			abortAll: () => {
				throw new Error("boom");
			},
			unmount: () => h.log.push("unmount"),
		});
		expect(h.log).toEqual(["unmount"]);
		expect(h.scheduled).toHaveLength(1);
	});

	test("a throwing unmount exits at once", () => {
		const h = harness();
		quitNow({
			...h.deps,
			abortAll: () => h.log.push("abort"),
			unmount: () => {
				throw new Error("boom");
			},
		});
		expect(h.log).toEqual(["abort", "exit:0"]);
	});

	test("the grace is short enough that quit feels instant", () => {
		expect(QUIT_GRACE_MS).toBeLessThanOrEqual(2000);
	});

	test("real timer: the hard exit fires while another timer keeps the loop busy", async () => {
		const exits: number[] = [];
		const busy = setInterval(() => {}, 5);
		quitNow({
			abortAll: () => {},
			unmount: () => {},
			hardExit: (c) => exits.push(c),
			graceMs: 20,
		});
		await new Promise((r) => setTimeout(r, 80));
		clearInterval(busy);
		expect(exits).toEqual([0]);
	});
});
