import { describe, expect, test } from "bun:test";
import { routineKinds, tickRoutines } from "./routines-tick";

type TickArgs = [Date, { kinds?: string[] }?];
const fakeManager = () => {
	const calls: TickArgs[] = [];
	return {
		calls,
		manager: {
			tick: async (...a: TickArgs) => {
				calls.push(a);
				return [];
			},
		},
	};
};
const at = new Date("2026-10-24T09:00:00.000Z");

describe("the daemon runs saved routines (#4926)", () => {
	test("a tick calls RoutineManager.tick with the time, scouts only by default", async () => {
		const f = fakeManager();
		await tickRoutines({ now: at, env: {}, manager: f.manager });
		expect(f.calls).toEqual([[at, { kinds: ["scout"] }]]);
	});

	test("ordinary routines run headless with --yes, so they stay opt-in: EIGHT_ROUTINES=1 turns them on", async () => {
		expect(routineKinds({})).toEqual(["scout"]);
		expect(routineKinds({ EIGHT_ROUTINES: "0" })).toEqual(["scout"]);
		expect(routineKinds({ EIGHT_ROUTINES: "false" })).toEqual(["scout"]);
		expect(routineKinds({ EIGHT_ROUTINES: "1" })).toBeUndefined();
		const f = fakeManager();
		await tickRoutines({ now: at, env: { EIGHT_ROUTINES: "1" }, manager: f.manager });
		expect(f.calls).toEqual([[at, { kinds: undefined }]]);
	});

	test("a tick that is still running is not started twice, and a failing tick does not throw", async () => {
		let release: () => void = () => {};
		let n = 0;
		const manager = {
			tick: () => {
				n++;
				return new Promise<never[]>((r) => {
					release = () => r([]);
				});
			},
		};
		const first = tickRoutines({ now: at, env: {}, manager });
		await tickRoutines({ now: at, env: {}, manager });
		expect(n).toBe(1);
		release();
		await first;
		await tickRoutines({
			now: at,
			env: {},
			manager: {
				tick: async () => {
					throw new Error("boom");
				},
			},
		});
		const third = tickRoutines({ now: at, env: {}, manager });
		expect(n).toBe(2);
		release();
		await third;
	});
});
