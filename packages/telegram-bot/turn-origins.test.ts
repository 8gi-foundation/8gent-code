/** #4834: a TUI turn on the Telegram session is never posted to Telegram. */
import { describe, expect, test } from "bun:test";
import { TurnOrigins } from "./turn-origins";

const final = { final: true, chunk: "x" };
const tui = { channel: "tui", text: "hi" };

describe("TurnOrigins", () => {
	test("the bridge's own turn is delivered end to end", () => {
		const t = new TurnOrigins();
		t.own();
		expect(t.deliver("tool:start", {})).toBe(true);
		expect(t.deliver("agent:stream", final)).toBe(true);
		expect(t.deliver("session:end", {})).toBe(true);
	});

	test("with nothing queued everything is the bridge's, as before", () => {
		const t = new TurnOrigins();
		expect(t.deliver("agent:stream", final)).toBe(true);
		expect(t.deliver("agent:error", {})).toBe(true);
		expect(t.deliver("session:end", {})).toBe(true);
	});

	test("a TUI turn is dropped whole: tools, final reply and its session:end", () => {
		const t = new TurnOrigins();
		expect(t.deliver("user:message", tui)).toBe(false);
		expect(t.deliver("tool:start", {})).toBe(false);
		expect(t.deliver("agent:stream", { final: false })).toBe(false);
		expect(t.deliver("agent:stream", final)).toBe(false);
		expect(t.deliver("session:end", {})).toBe(false);
		// and the bridge is back to normal for the next turn
		t.own();
		expect(t.deliver("agent:stream", final)).toBe(true);
		expect(t.deliver("session:end", {})).toBe(true);
	});

	test("an echo of the bridge's own channel is not another surface", () => {
		const t = new TurnOrigins();
		expect(t.deliver("user:message", { channel: "telegram" })).toBe(false);
		t.own();
		expect(t.deliver("agent:stream", final)).toBe(true);
	});

	test("order is kept when turns queue: TUI first, then Telegram", () => {
		const t = new TurnOrigins();
		t.deliver("user:message", tui);
		t.own();
		expect(t.deliver("agent:stream", final)).toBe(false); // the TUI's
		expect(t.deliver("session:end", {})).toBe(false);
		expect(t.deliver("agent:stream", final)).toBe(true); // Telegram's
		expect(t.deliver("session:end", {})).toBe(true);
	});

	test("order is kept the other way: Telegram first, then TUI", () => {
		const t = new TurnOrigins();
		t.own();
		t.deliver("user:message", tui);
		expect(t.deliver("agent:stream", final)).toBe(true);
		expect(t.deliver("session:end", {})).toBe(true);
		expect(t.deliver("agent:stream", final)).toBe(false);
		expect(t.deliver("session:end", {})).toBe(false);
	});

	test("a TUI turn that errors posts no error to Telegram, and has no session:end to swallow", () => {
		const t = new TurnOrigins();
		t.deliver("user:message", tui);
		expect(t.deliver("agent:error", { error: "boom" })).toBe(false);
		t.own();
		expect(t.deliver("session:end", {})).toBe(true);
	});

	test("reset forgets the queue", () => {
		const t = new TurnOrigins();
		t.deliver("user:message", tui);
		t.reset();
		expect(t.deliver("agent:stream", final)).toBe(true);
	});
});

describe("TurnOrigins with a daemon that tags events", () => {
	const tagged = () => {
		const t = new TurnOrigins();
		t.setCapabilities(["input-gate", "turn-origin"]);
		return t;
	};
	const ev = (origin: unknown, extra: Record<string, unknown> = {}) => ({ origin, ...extra });

	test("delivers only events whose origin is the bridge's own channel", () => {
		const t = tagged();
		expect(t.deliver("agent:stream", ev("telegram", final))).toBe(true);
		expect(t.deliver("agent:stream", ev("tui", final))).toBe(false);
		expect(t.deliver("tool:start", ev("tui"))).toBe(false);
		expect(t.deliver("tool:result", ev("telegram"))).toBe(true);
		expect(t.deliver("agent:error", ev("tui"))).toBe(false);
		expect(t.deliver("session:end", ev("telegram", { reason: "turn-complete" }))).toBe(true);
		expect(t.deliver("session:end", ev("tui", { reason: "turn-complete" }))).toBe(false);
	});

	test("drops untagged and ambiguous turn output: fail closed", () => {
		const t = tagged();
		expect(t.deliver("agent:stream", final)).toBe(false);
		expect(t.deliver("agent:stream", ev(null, final))).toBe(false);
		expect(t.deliver("agent:error", {})).toBe(false);
		expect(t.deliver("session:end", { reason: "turn-complete" })).toBe(false);
	});

	test("events that are not a turn's output still pass, and user:message never does", () => {
		const t = tagged();
		expect(t.deliver("session:end", { reason: "idle-timeout" })).toBe(true);
		expect(t.deliver("approval:required", {})).toBe(true);
		expect(t.deliver("user:message", { channel: "tui" })).toBe(false);
	});

	test("a reset in the middle of someone else's turn changes nothing: the tags decide", () => {
		const t = tagged();
		t.deliver("tool:start", ev("tui"));
		t.reset();
		t.setCapabilities(["input-gate", "turn-origin"]);
		expect(t.deliver("agent:stream", ev("tui", final))).toBe(false);
		expect(t.deliver("session:end", ev("tui", { reason: "turn-complete" }))).toBe(false);
		expect(t.deliver("agent:stream", ev("telegram", final))).toBe(true);
	});

	test("a daemon without the capability keeps the queue behaviour", () => {
		const t = new TurnOrigins();
		t.setCapabilities(["input-gate"]);
		expect(t.deliver("agent:stream", final)).toBe(true);
		t.deliver("user:message", tui);
		expect(t.deliver("agent:stream", final)).toBe(false);
	});
});
