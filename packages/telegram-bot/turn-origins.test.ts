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
