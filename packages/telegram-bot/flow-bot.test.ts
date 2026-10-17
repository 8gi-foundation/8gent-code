import { describe, expect, test } from "bun:test";
import { createCaptureGate } from "../flow/flow-capture";
import { createFlowModeController } from "../flow/flow-mode";
import {
	type FlowController,
	type FlowLogRow,
	type FlowModeName,
	type PendingStore,
	type TapDeps,
	classifyVoice,
	controllerFor,
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

/** The real controller from packages/flow, with a shared test clock. */
function rig(now = { t: 1_000_000 }, start: FlowModeName = "act") {
	const real = createFlowModeController(
		() => now.t,
		() => "ask",
	);
	const ctl: FlowController = controllerFor(real, () => "ask");
	const gate = createCaptureGate(() => now.t);
	const store = createPendingStore(() => now.t);
	const logs: FlowLogRow[] = [];
	const decisions: string[] = [];
	if (start !== "act") real.userSwitch(start, "user-key");
	/** What the controller actually accepted, in order. */
	const base = real.log.length;
	const applied = () =>
		real.log
			.slice(base)
			.filter((l) => l.accepted)
			.map((l) => ({ to: l.to, origin: l.origin }));
	/** Ask the controller for a judge proposal, as a spoken note plus a judge verdict would. */
	const propose = (to: FlowModeName) => {
		now.t += 2_000;
		const u = gate.admit({
			text: "hmm that is a lot",
			pttActive: true,
			startedAt: now.t - 500,
			endedAt: now.t,
		});
		const tk = real.beginJudge(u as NonNullable<typeof u>);
		real.judgeResult(tk as NonNullable<typeof tk>, { to });
	};
	const deps = (over: Partial<TapDeps> = {}): TapDeps => ({
		store,
		ctl,
		ops,
		now: () => now.t,
		log: (r) => void logs.push(r),
		recordDecision: (a) => void decisions.push(a),
		...over,
	});
	return { real, ctl, store, logs, decisions, deps, now, applied, propose };
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
		r.propose("quiet");
		expect(proposalCard(r.store, DM, r.ctl, "quiet")).not.toBeNull();
		r.now.t += 2_000;
		expect(proposalCard(r.store, DM, r.ctl, "think")).toBeNull();
		r.now.t += 5 * 60_000;
		expect(proposalCard(r.store, DM, r.ctl, "think")).not.toBeNull();
	});
	test("C10: the judge cannot propose a raise, and junk targets mint nothing (real canSwitch)", () => {
		const r = rig(undefined, "think");
		expect(proposalCard(r.store, DM, r.ctl, "act")).toBeNull();
		expect(proposalCard(r.store, DM, r.ctl, "infinite" as FlowModeName)).toBeNull();
		expect(proposalCard(r.store, DM, r.ctl, "guarded" as FlowModeName)).toBeNull();
		expect(r.store.size()).toBe(0);
	});
	test("user-button is a real origin: canSwitch passes it, the judge gate still refuses a raise", () => {
		const r = rig(undefined, "think");
		expect(r.ctl.canSwitch("think", "act", "user-button")).toBe(true);
		expect(r.ctl.canSwitch("think", "act", "judge")).toBe(false);
	});
});

describe("tap (C8 C9)", () => {
	test("menu tap: origin user-button, raise allowed, card retired", () => {
		const r = rig(undefined, "think");
		const c = sent(r.store, menuCard(r.store, DM, r.ctl));
		const act = c.keyboard.inline_keyboard[0]?.findIndex((b) => b.text === "Act") as number;
		const res = handleFlowTap(tap(dataOf(c, act)), r.deps());
		expect(r.applied()).toEqual([{ to: "act", origin: "user-button" }]);
		expect(res.editTo).toBeDefined();
		expect(r.store.size()).toBe(0);
	});
	test("proposal Yes maps to user-voice-confirmed; No changes nothing and blocks a repeat", () => {
		const r = rig();
		r.propose("quiet");
		const c = sent(r.store, proposalCard(r.store, DM, r.ctl, "quiet"));
		handleFlowTap(tap(dataOf(c, 0)), r.deps());
		expect(r.applied()).toEqual([{ to: "quiet", origin: "user-voice-confirmed" }]);
		const r2 = rig();
		r2.propose("quiet");
		const c2 = sent(r2.store, proposalCard(r2.store, DM, r2.ctl, "quiet"));
		handleFlowTap(tap(dataOf(c2, 1)), r2.deps());
		expect(r2.applied()).toEqual([]);
		expect(r2.logs.at(-1)?.signal).toBe("declined");
		expect(r2.real.pendingProposal).toBeNull();
	});
	test("T8: a Yes can never raise: the mode moved lower after minting, so Yes is dead", () => {
		const r = rig(undefined, "act");
		r.propose("quiet");
		const c = sent(r.store, proposalCard(r.store, DM, r.ctl, "quiet"));
		r.real.userSwitch("think", "user-key"); // now quiet would be a raise over think
		const res = handleFlowTap(tap(dataOf(c, 0)), r.deps());
		expect(r.real.mode).toBe("think");
		expect(r.applied()).toEqual([{ to: "think", origin: "user-key" }]);
		expect(res.editTo).toBeDefined();
	});
	test("a Yes with no open proposal in the controller does nothing", () => {
		const r = rig();
		r.propose("quiet");
		const c = sent(r.store, proposalCard(r.store, DM, r.ctl, "quiet"));
		r.real.resetSession();
		handleFlowTap(tap(dataOf(c, 0)), r.deps());
		expect(r.real.mode).toBe("act");
	});
	test("restore: user-button to the controller snapshot; a stale snapshot is refused", () => {
		const r = rig(undefined, "act");
		r.real.userSwitch("quiet", "user-key");
		const c = sent(r.store, restoreCard(r.store, DM, r.ctl));
		handleFlowTap(tap(dataOf(c)), r.deps());
		expect(r.real.mode).toBe("act");
		expect(r.applied().at(-1)).toEqual({ to: "act", origin: "user-button" });
		const r2 = rig(undefined, "act");
		r2.real.userSwitch("quiet", "user-key");
		const c2 = sent(r2.store, restoreCard(r2.store, DM, r2.ctl));
		r2.real.userSwitch("think", "user-key"); // snapshot is now quiet, not act
		handleFlowTap(tap(dataOf(c2)), r2.deps());
		expect(r2.real.mode).toBe("think");
		expect(restoreCard(r2.store, DM, rig().ctl)).toBeNull();
	});
	test("decision card: records an answer, changes no mode, calls no controller apply", () => {
		const r = rig();
		const c = sent(r.store, decisionCard(r.store, DM, "Which one?", ["Blue", "Green"]));
		expect(dataOf(c, 1)).toMatch(/^fd:/);
		const res = handleFlowTap(tap(dataOf(c, 1)), r.deps());
		expect(r.decisions).toEqual(["Green"]);
		expect(r.applied()).toEqual([]);
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
		expect(r.applied()).toEqual([]);
		expect(r.store.size()).toBeGreaterThan(0); // the real card is still live
	});
	test("T4: replay, restart, expiry, wrong message id, wrong chat id", () => {
		const r = rig(undefined, "think");
		const c = sent(r.store, menuCard(r.store, DM, r.ctl));
		const d = dataOf(c, 0);
		handleFlowTap(tap(d), r.deps());
		expect(r.applied().length).toBe(1);
		const replay = handleFlowTap(tap(d), r.deps());
		expect(replay.say).toMatch(/no longer live/);
		expect(r.applied().length).toBe(1);

		const r2 = rig(undefined, "think");
		const c2 = sent(r2.store, menuCard(r2.store, DM, r2.ctl));
		r2.store.clear(); // restart
		handleFlowTap(tap(dataOf(c2)), r2.deps());
		expect(r2.applied()).toEqual([]);

		const r3 = rig(undefined, "think");
		const c3 = sent(r3.store, menuCard(r3.store, DM, r3.ctl));
		r3.now.t += 121_000;
		const late = handleFlowTap(tap(dataOf(c3)), r3.deps());
		expect(late.say).toMatch(/expired/);
		expect(r3.applied()).toEqual([]);

		const r4 = rig(undefined, "think");
		const c4 = sent(r4.store, menuCard(r4.store, DM, r4.ctl));
		handleFlowTap(tap(dataOf(c4), { message: { message_id: 8, chat: DM } }), r4.deps());
		handleFlowTap(
			tap(dataOf(c4), { message: { message_id: 7, chat: { id: 1, type: "private" } } }),
			r4.deps(),
		);
		expect(r4.applied()).toEqual([]);
		// an unsent (unbound) card cannot be tapped either
		const c5 = menuCard(r4.store, DM, r4.ctl) as NonNullable<ReturnType<typeof menuCard>>;
		handleFlowTap(tap(dataOf(c5)), r4.deps());
		expect(r4.applied()).toEqual([]);
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
		expect(r.applied()).toEqual([]);
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
		expect(r.applied()).toEqual([]);
		expect(r.decisions).toEqual([]);
	});
	test("T9: no controller, no operators: off, nothing applied", () => {
		const r = rig();
		const c = sent(r.store, menuCard(r.store, DM, r.ctl));
		expect(handleFlowTap(tap(dataOf(c)), r.deps({ ctl: undefined })).say).toMatch(/Not available/);
		expect(handleFlowTap(tap(dataOf(c)), r.deps({ ops: [] })).say).toMatch(/Not available/);
		expect(r.applied()).toEqual([]);
	});
	test("C9.4: the token is retired before the controller is applied", () => {
		const r = rig(undefined, "think");
		const c = sent(r.store, menuCard(r.store, DM, r.ctl));
		let sizeDuringApply = -1;
		const inner = r.ctl.switchTo;
		const spy: FlowController = {
			...r.ctl,
			switchTo: (to) => {
				sizeDuringApply = r.store.size();
				return inner(to);
			},
		};
		handleFlowTap(tap(dataOf(c)), r.deps({ ctl: spy }));
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
			proposalCard(r.store, DM, r.ctl, "think"),
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
