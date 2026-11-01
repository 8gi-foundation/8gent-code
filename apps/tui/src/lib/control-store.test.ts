import { describe, expect, test } from "bun:test";
import type { ControlConfig, ReadResult } from "./control-state.js";
import { HEADER_REFRESH_MS, WATCH_DEBOUNCE_MS, createControlStore } from "./control-store.js";

const cfg: ControlConfig = {
	sources: [
		{ type: "jobs", dir: "/x/jobs" },
		{ type: "merge-ready", path: "/x/ready.txt", queueLog: "/x/log.jsonl" },
	],
	staleAfterMin: 60,
	helperCap: 4,
	diskFloorGB: 30,
};

function rig() {
	const state = {
		loads: 0,
		opened: [] as string[],
		closed: 0,
		timers: [] as { fn: () => void; ms: number; live: boolean }[],
	};
	const fire: Record<string, () => void> = {};
	let rows: ReadResult["rows"] = [];
	const store = createControlStore({
		load: () => {
			state.loads += 1;
			return { cfg, result: { rows, problems: [] } };
		},
		watch: (target, onChange) => {
			state.opened.push(target);
			fire[target] = onChange;
			return { close: () => void (state.closed += 1) };
		},
		setTimer: (fn, ms) => {
			const t = { fn, ms, live: true };
			state.timers.push(t);
			return t;
		},
		clearTimer: (t) => void ((t as { live: boolean }).live = false),
	});
	return { state, fire, store, setRows: (r: ReadResult["rows"]) => void (rows = r) };
}

const row = (name: string) => ({
	kind: "k",
	name,
	state: "running" as const,
	stage: "",
	last: null,
	next: null,
	waitingOn: null,
	detail: "",
});

describe("control store is lazy", () => {
	test("nothing is read, watched or timed until the first subscriber", () => {
		const { state, store } = rig();
		expect(state.loads).toBe(0);
		expect(state.opened).toEqual([]);
		expect(state.timers).toEqual([]);
		expect(store.get()).toBeNull();
		expect(store.subscribers()).toBe(0);
	});

	test("first subscriber reads once and watches every source; last unsubscribe closes all", () => {
		const { state, store } = rig();
		const a = store.subscribe(() => {});
		const b = store.subscribe(() => {});
		expect(state.loads).toBe(1);
		expect(state.opened).toEqual(["/x/jobs", "/x/ready.txt", "/x/log.jsonl"]);
		a();
		expect(state.closed).toBe(0);
		b();
		expect(state.closed).toBe(3);
		expect(store.get()).toBeNull();
	});

	test("a burst of file events is one read after the debounce, and the listener hears it", () => {
		const { state, fire, store, setRows } = rig();
		let heard = 0;
		store.subscribe(() => void (heard += 1));
		const before = state.loads;
		const heardBefore = heard;
		fire["/x/jobs"]();
		fire["/x/jobs"]();
		fire["/x/ready.txt"]();
		const live = state.timers.filter((t) => t.live && t.ms === WATCH_DEBOUNCE_MS);
		expect(live.length).toBe(1);
		expect(state.loads).toBe(before);
		setRows([row("a")]);
		live[0].fn();
		expect(state.loads).toBe(before + 1);
		expect(heard).toBe(heardBefore + 1);
		expect(store.get()?.rows.map((r) => r.name)).toEqual(["a"]);
	});

	test("no timer runs at idle: the slow header refresh exists only for a header subscriber, and never under 2 s", () => {
		const { state, store } = rig();
		const rail = store.subscribe(() => {});
		expect(state.timers.filter((t) => t.live)).toEqual([]);
		const tab = store.subscribe(() => {}, { header: true });
		const live = state.timers.filter((t) => t.live);
		expect(live.length).toBe(1);
		expect(live[0].ms).toBe(HEADER_REFRESH_MS);
		expect(HEADER_REFRESH_MS).toBeGreaterThanOrEqual(2000);
		expect(WATCH_DEBOUNCE_MS).toBeLessThan(2000);
		const loadsBefore = state.loads;
		live[0].live = false;
		live[0].fn();
		expect(state.loads).toBe(loadsBefore);
		tab();
		expect(state.timers.filter((t) => t.live)).toEqual([]);
		rail();
	});

	test("header carries load, disk, helper count and the configured cap", () => {
		const { store, setRows } = rig();
		setRows([row("a"), row("b")]);
		store.subscribe(() => {});
		const h = store.get()?.header;
		expect(h?.helpers).toBe(2);
		expect(h?.helperCap).toBe(4);
		expect(h?.diskFloorGB).toBe(30);
		expect(typeof h?.load).toBe("number");
	});
});
