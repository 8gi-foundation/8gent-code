import { describe, expect, test } from "bun:test";
import {
	type FlowController,
	type FlowLogRow,
	type FlowModeName,
	type FlowOrigin,
	type PendingStore,
	type TapDeps,
	classifyVoice,
	createEchoGuard,
	createPendingStore,
	decisionCard,
	flowOperators,
	handleFlowTap,
	isFlowCallback,
	menuCard,
	proposalCard,
	restoreCard,
} from "./flow-bot";

const JAMES = 5486040131;
const ARTALE = 8270920648;
const ops = [String(JAMES)];
const DM = { id: JAMES, type: "private" };
const CANARY = "CANARY-purple-elephant-7731";

/** Stand-in for the real controller (it lives on 8gut). Same shape of rule: the judge may only lower. */
function fakeCtl(start: FlowModeName = "act") {
	const rank: Record<string, number> = { listen: 0, think: 1, quiet: 2, act: 2 };
	let mode = start;
	let snap: FlowModeName | null = null;
	const applied: { to: FlowModeName; origin: FlowOrigin }[] = [];
	const ctl: FlowController = {
		mode: () => mode,
		canSwitch: (from, to, origin) =>
			rank[to] !== undefined &&
			rank[from] !== undefined &&
			(origin !== "judge" || (rank[to] as number) <= (rank[from] as number)),
		apply: (to, origin) => {
			applied.push({ to, origin });
			const changed = to !== mode;
			mode = to;
			return { changed, mode };
		},
		snapshot: () => snap,
	};
	return {
		ctl,
		applied,
		setSnap: (m: FlowModeName | null) => void (snap = m),
		setMode: (m: FlowModeName) => void (mode = m),
	};
}

function rig(now = { t: 1_000_000 }, start: FlowModeName = "act") {
	const f = fakeCtl(start);
	const store = createPendingStore(() => now.t);
	const logs: FlowLogRow[] = [];
	const decisions: string[] = [];
	const deps = (over: Partial<TapDeps> = {}): TapDeps => ({
		store,
		ctl: f.ctl,
		ops,
		now: () => now.t,
		log: (r) => void logs.push(r),
		recordDecision: (a) => void decisions.push(a),
		...over,
	});
	return { ...f, store, logs, decisions, deps, now };
}
const tap = (data: string, over: object = {}) => ({
	from: { id: JAMES },
	data,
	message: { message_id: 7, chat: DM },
	...over,
});
const dataOf = (card: { keyboard: { inline_keyboard: { callback_data: string }[][] } }, i = 0) =>
	card.keyboard.inline_keyboard[0]?.[i]?.callback_data as string;
function sent<T extends { tokens: string[] }>(store: PendingStore, card: T | null, id = 7): T {
	expect(card).not.toBeNull();
	store.bind((card as T).tokens, id);
	return card as T;
}

describe("operators and voice class (C1 C2 C3 C6)", () => {
	test("C2: an empty or junk list is off, never everyone", () => {
		expect(flowOperators(undefined)).toEqual([]);
		expect(flowOperators(["", " x ", "12a"])).toEqual([]);
		expect(flowOperators([" 5486040131 "])).toEqual(["5486040131"]);
	});
	test("operator private DM voice note is user-voice", () => {
		expect(classifyVoice({ from: { id: JAMES }, chat: DM }, ops)).toBe("user-voice");
	});
	test("C3: forward_origin and via_bot are user-forwarded", () => {
		expect(
			classifyVoice({ from: { id: JAMES }, chat: DM, forward_origin: { type: "user" } }, ops),
		).toBe("user-forwarded");
		expect(classifyVoice({ from: { id: JAMES }, chat: DM, via_bot: { id: 1 } }, ops)).toBe(
			"user-forwarded",
		);
	});
	test("C6: Artale, and the operator in a group, are plain", () => {
		expect(
			classifyVoice({ from: { id: ARTALE }, chat: { id: ARTALE, type: "private" } }, ops),
		).toBe("plain");
		expect(
			classifyVoice({ from: { id: JAMES }, chat: { id: -100, type: "supergroup" } }, ops),
		).toBe("plain");
		expect(classifyVoice({ from: { id: JAMES }, chat: { id: 5, type: "private" } }, ops)).toBe(
			"plain",
		);
	});
	test("T9: empty operator list means no voice signal", () => {
		expect(classifyVoice({ from: { id: JAMES }, chat: DM }, [])).toBe("plain");
	});
});

describe("echo overlap (C4)", () => {
	test("our own sentence replayed within 30 s is an echo, later or different is not", () => {
		const t = { v: 0 };
		const g = createEchoGuard(() => t.v);
		g.record("The build is green and the branch is pushed to the remote.");
		expect(g.isEcho("the build is green and the branch is pushed")).toBe(true);
		expect(g.isEcho("go ahead and do it now please")).toBe(false);
		t.v = 31_000;
		expect(g.isEcho("the build is green and the branch is pushed")).toBe(false);
	});
});

describe("mint (C11 C12 C13)", () => {
	test("C11: nothing is minted in a group", () => {
		const r = rig();
		expect(menuCard(r.store, { id: -100, type: "supergroup" }, r.ctl)).toBeNull();
		expect(r.store.size()).toBe(0);
	});
	test("tokens are opaque: no mode, origin or time in callback_data", () => {
		const r = rig();
		const c = menuCard(r.store, DM, r.ctl) as NonNullable<ReturnType<typeof menuCard>>;
		for (const row of c.keyboard.inline_keyboard) {
			for (const b of row) {
				expect(b.callback_data).toMatch(/^fm:[A-Za-z0-9_-]{11}$/);
				expect(b.callback_data).not.toMatch(/act|think|quiet|user|judge/);
				expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
			}
		}
	});
	test("C13: cap 16, oldest evicted; one inferred proposal per 5 min", () => {
		const r = rig();
		for (let i = 0; i < 12; i++) menuCard(r.store, DM, r.ctl);
		expect(r.store.size()).toBeLessThanOrEqual(16);
		const a = proposalCard(r.store, DM, r.ctl, "quiet");
		expect(a).not.toBeNull();
		expect(proposalCard(r.store, DM, r.ctl, "think")).toBeNull();
		r.now.t += 5 * 60_000;
		expect(proposalCard(r.store, DM, r.ctl, "think")).not.toBeNull();
	});
	test("C10: the judge cannot propose a raise, and junk targets mint nothing", () => {
		const r = rig(undefined, "quiet");
		r.ctl.apply("think", "judge");
		expect(proposalCard(r.store, DM, r.ctl, "act")).toBeNull();
		expect(proposalCard(r.store, DM, r.ctl, "infinite" as FlowModeName)).toBeNull();
		expect(r.store.size()).toBe(0);
	});
});

describe("tap (C8 C9)", () => {
	test("menu tap: origin user-button, raise allowed, card retired", () => {
		const r = rig(undefined, "think");
		const c = sent(r.store, menuCard(r.store, DM, r.ctl));
		const act = c.keyboard.inline_keyboard[0]?.findIndex((b) => b.text === "Act") as number;
		const res = handleFlowTap(tap(dataOf(c, act)), r.deps());
		expect(r.applied).toEqual([{ to: "act", origin: "user-button" }]);
		expect(res.editTo).toBeDefined();
		expect(r.store.size()).toBe(0);
	});
	test("proposal Yes maps to user-voice-confirmed; No changes nothing", () => {
		const r = rig();
		const c = sent(r.store, proposalCard(r.store, DM, r.ctl, "quiet"));
		handleFlowTap(tap(dataOf(c, 0)), r.deps());
		expect(r.applied).toEqual([{ to: "quiet", origin: "user-voice-confirmed" }]);
		const r2 = rig();
		const c2 = sent(r2.store, proposalCard(r2.store, DM, r2.ctl, "quiet"));
		handleFlowTap(tap(dataOf(c2, 1)), r2.deps());
		expect(r2.applied).toEqual([]);
		expect(r2.logs.at(-1)?.signal).toBe("declined");
	});
	test("T8: a raise on a proposal card is refused at tap even with a valid token", () => {
		const r = rig(undefined, "act");
		const c = sent(r.store, proposalCard(r.store, DM, r.ctl, "quiet"));
		// Mode moved lower after minting: Yes would now be a raise.
		r.setMode("think");
		const res = handleFlowTap(tap(dataOf(c, 0)), r.deps());
		expect(r.applied).toEqual([]);
		expect(res.say).toMatch(/yours to set/);
	});
	test("restore: user-button, target is the snapshot only", () => {
		const r = rig(undefined, "quiet");
		r.setSnap("act");
		const c = sent(r.store, restoreCard(r.store, DM, r.ctl));
		handleFlowTap(tap(dataOf(c)), r.deps());
		expect(r.applied).toEqual([{ to: "act", origin: "user-button" }]);
		const r2 = rig(undefined, "quiet");
		r2.setSnap("think");
		const c2 = sent(r2.store, restoreCard(r2.store, DM, r2.ctl));
		r2.setSnap("listen");
		handleFlowTap(tap(dataOf(c2)), r2.deps());
		expect(r2.applied).toEqual([]);
		expect(restoreCard(r2.store, DM, fakeCtl().ctl)).toBeNull();
	});
	test("decision card: records an answer, changes no mode, calls no controller apply", () => {
		const r = rig();
		const c = sent(r.store, decisionCard(r.store, DM, "Which one?", ["Blue", "Green"]));
		expect(dataOf(c, 1)).toMatch(/^fd:/);
		const res = handleFlowTap(tap(dataOf(c, 1)), r.deps());
		expect(r.decisions).toEqual(["Green"]);
		expect(r.applied).toEqual([]);
		expect(res.editTo).toBe("Noted.");
	});
	test("T3: non-operator, operator in a group, forwarded card: nothing happens", () => {
		const r = rig();
		const c = sent(r.store, menuCard(r.store, DM, r.ctl));
		const d = dataOf(c);
		handleFlowTap(tap(d, { from: { id: ARTALE } }), r.deps());
		handleFlowTap(
			tap(d, { message: { message_id: 7, chat: { id: -100, type: "supergroup" } } }),
			r.deps(),
		);
		handleFlowTap(
			tap(d, { message: { message_id: 7, chat: { id: ARTALE, type: "private" } } }),
			r.deps(),
		);
		handleFlowTap(tap(d, { message: undefined }), r.deps());
		expect(r.applied).toEqual([]);
		expect(r.store.size()).toBeGreaterThan(0); // the real card is still live
	});
	test("T4: replay, restart, expiry, wrong message id, wrong chat id", () => {
		const r = rig(undefined, "think");
		const c = sent(r.store, menuCard(r.store, DM, r.ctl));
		const d = dataOf(c, 0);
		handleFlowTap(tap(d), r.deps());
		expect(r.applied.length).toBe(1);
		const replay = handleFlowTap(tap(d), r.deps());
		expect(replay.say).toMatch(/no longer live/);
		expect(r.applied.length).toBe(1);

		const r2 = rig(undefined, "think");
		const c2 = sent(r2.store, menuCard(r2.store, DM, r2.ctl));
		r2.store.clear(); // restart
		handleFlowTap(tap(dataOf(c2)), r2.deps());
		expect(r2.applied).toEqual([]);

		const r3 = rig(undefined, "think");
		const c3 = sent(r3.store, menuCard(r3.store, DM, r3.ctl));
		r3.now.t += 121_000;
		const late = handleFlowTap(tap(dataOf(c3)), r3.deps());
		expect(late.say).toMatch(/expired/);
		expect(r3.applied).toEqual([]);

		const r4 = rig(undefined, "think");
		const c4 = sent(r4.store, menuCard(r4.store, DM, r4.ctl));
		handleFlowTap(tap(dataOf(c4), { message: { message_id: 8, chat: DM } }), r4.deps());
		handleFlowTap(
			tap(dataOf(c4), { message: { message_id: 7, chat: { id: 1, type: "private" } } }),
			r4.deps(),
		);
		expect(r4.applied).toEqual([]);
		// an unsent (unbound) card cannot be tapped either
		const c5 = menuCard(r4.store, DM, r4.ctl) as NonNullable<ReturnType<typeof menuCard>>;
		handleFlowTap(tap(dataOf(c5)), r4.deps());
		expect(r4.applied).toEqual([]);
	});
	test("T5: callback_data tampered to a mode name, origin string or decision prefix is only a failed lookup", () => {
		const r = rig(undefined, "think");
		const c = sent(r.store, menuCard(r.store, DM, r.ctl));
		for (const d of [
			"fm:act",
			"fm:user-key",
			"fm:judge",
			"fm:quiet",
			"fd:" + dataOf(c).slice(3),
			"fm:",
			"fm:" + "A".repeat(200),
			"zz:1",
		]) {
			handleFlowTap(tap(d), r.deps());
		}
		expect(r.applied).toEqual([]);
		expect(r.decisions).toEqual([]);
	});
	test("a decision token cannot be played as a mode card or the reverse", () => {
		const r = rig();
		const dc = sent(r.store, decisionCard(r.store, DM, "q", ["a"]));
		handleFlowTap(tap(`fm:${dataOf(dc).slice(3)}`), r.deps());
		const mc = sent(r.store, menuCard(r.store, DM, r.ctl), 8);
		handleFlowTap(
			tap(`fd:${dataOf(mc).slice(3)}`, { message: { message_id: 8, chat: DM } }),
			r.deps(),
		);
		expect(r.applied).toEqual([]);
		expect(r.decisions).toEqual([]);
	});
	test("T9: no controller, no operators: off, nothing applied", () => {
		const r = rig();
		const c = sent(r.store, menuCard(r.store, DM, r.ctl));
		expect(handleFlowTap(tap(dataOf(c)), r.deps({ ctl: undefined })).say).toMatch(/Not available/);
		expect(handleFlowTap(tap(dataOf(c)), r.deps({ ops: [] })).say).toMatch(/Not available/);
		expect(r.applied).toEqual([]);
	});
	test("C9.4: the token is deleted before the controller is applied", () => {
		const r = rig(undefined, "think");
		const c = sent(r.store, menuCard(r.store, DM, r.ctl));
		let sizeDuringApply = -1;
		const real = r.ctl.apply;
		r.ctl.apply = (to, o) => {
			sizeDuringApply = r.store.size();
			return real(to, o);
		};
		handleFlowTap(tap(dataOf(c)), r.deps());
		expect(sizeDuringApply).toBe(0);
	});
	test("isFlowCallback matches only the flow prefixes, not approvals", () => {
		expect(isFlowCallback("fm:abc")).toBe(true);
		expect(isFlowCallback("fd:abc")).toBe(true);
		for (const d of ["approve:1", "deny:1", "allowchat:1", "tc:1", undefined]) {
			expect(isFlowCallback(d)).toBe(false);
		}
	});
});

describe("T10 / C14 / C17: no canary in logs or card text", () => {
	test("the flow log row has no token, data or text; cards carry fixed text only", () => {
		const r = rig(undefined, "think");
		const cards = [
			menuCard(r.store, DM, r.ctl),
			proposalCard(r.store, DM, r.ctl, "listen"),
			decisionCard(r.store, DM, "Which one?", ["Blue"]),
		];
		const tokens = cards.flatMap((c) => c?.tokens ?? []);
		for (const c of cards) r.store.bind(c?.tokens ?? [], 7);
		const first = cards[0] as NonNullable<(typeof cards)[0]>;
		handleFlowTap(tap(dataOf(first), { from: { id: JAMES } }), r.deps());
		handleFlowTap(tap(`fm:${CANARY}`), r.deps());
		const all = JSON.stringify([r.logs, cards.map((c) => c?.text)]);
		expect(all).not.toContain("CANARY");
		for (const t of tokens) expect(JSON.stringify(r.logs)).not.toContain(t);
		for (const row of r.logs) {
			expect(Object.keys(row).sort()).toEqual(["accepted", "at", "from", "origin", "signal", "to"]);
		}
	});
});
