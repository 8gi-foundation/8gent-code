/**
 * A huddle is a GROUP CALL, not a fixed committee.
 *
 * James: "huddle shouldnt be hardcoded to certain agents or whatever, i should
 * be able to add and remove 8gents at will. its like a group call basically."
 *
 * Before this the ring was derived once in the FloorMachine constructor and
 * never revisited, so whoever you opened with was who you were stuck with for
 * the whole huddle.
 *
 * The interesting cases are not join and leave - they are the two ways a naive
 * implementation corrupts the ring:
 *   - dropping someone who ALREADY SPOKE must not make the room skip whoever
 *     stands behind them (ringPos has to come back by one)
 *   - dropping whoever HOLDS THE FLOOR must release it, or the room waits
 *     forever on a participant who has left
 */

import { describe, expect, it } from "bun:test";
import { CHAIR_HUMAN_ID, FloorMachine, type HuddleOpenConfig, type HuddleOutFrame } from "../floor";

function machine(roster: string[]) {
	const frames: HuddleOutFrame[] = [];
	const config: HuddleOpenConfig = {
		huddleId: "roster-test",
		channelId: "chan-roster",
		openedBy: "human:local",
		roster: ["human:local", ...roster],
		topic: "group call",
		chair: CHAIR_HUMAN_ID,
		chairMode: "agent", // keep the chair out of the way; the ring is under test
		maxRounds: 1,
		maxDurationMs: 5_000,
		prepareBudgetMs: 30,
		speakMsOverride: 2,
	};
	const m = new FloorMachine(config, {
		emit: (f) => frames.push(f),
		prepareAgentTurn: async () => "a turn",
	});
	return { m, frames };
}

const ringOf = (frames: HuddleOutFrame[]) =>
	[...frames].reverse().find((f) => f.type === "huddle:roster") as
		| Extract<HuddleOutFrame, { type: "huddle:roster" }>
		| undefined;

describe("huddle roster is mutable while running", () => {
	it("admits someone mid-huddle, at the END of the ring", () => {
		const { m, frames } = machine(["agent:8TO", "agent:8SO"]);
		expect(m.invite("human:local", "agent:8PO")).toBe("ok");
		const f = ringOf(frames);
		expect(f?.change).toBe("joined");
		expect(f?.participantId).toBe("agent:8PO");
		// Appended, never spliced ahead of the current position - inserting
		// earlier would replay a seat somebody already had.
		expect(f?.ring.at(-1)).toBe("agent:8PO");
	});

	it("removes someone mid-huddle", () => {
		const { m, frames } = machine(["agent:8TO", "agent:8SO"]);
		expect(m.drop("human:local", "agent:8TO")).toBe("ok");
		const f = ringOf(frames);
		expect(f?.change).toBe("left");
		expect(f?.ring).not.toContain("agent:8TO");
		expect(f?.ring).toContain("agent:8SO");
	});

	it("is idempotent both ways, so a double click is harmless", () => {
		const { m } = machine(["agent:8TO"]);
		expect(m.invite("human:local", "agent:8TO")).toBe("ok"); // already present
		expect(m.drop("human:local", "agent:8PO")).toBe("dropped"); // never present
		expect(m.drop("human:local", "agent:8TO")).toBe("ok");
		expect(m.drop("human:local", "agent:8TO")).toBe("dropped"); // gone already
	});

	it("refuses an officer trying to pick the room", () => {
		const { m, frames } = machine(["agent:8TO"]);
		expect(m.invite("agent:8TO", "agent:8SO")).toBe("forbidden");
		expect(m.drop("agent:8TO", "agent:8SO")).toBe("forbidden");
		const err = frames.find((f) => f.type === "huddle:error");
		expect(err).toBeDefined();
		// No roster change may have leaked out of a forbidden call.
		expect(frames.some((f) => f.type === "huddle:roster")).toBe(false);
	});

	it("does not skip the next speaker when an EARLIER member is dropped", async () => {
		// The subtle one. 8TO speaks, then 8TO is dropped. 8SO stands behind
		// them; if ringPos is not pulled back, the room skips straight past 8SO.
		const { m, frames } = machine(["agent:8TO", "agent:8SO", "agent:8PO"]);
		m.open();
		for (let i = 0; i < 40 && !frames.some((f) => f.type === "huddle:floor_released"); i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		m.drop("human:local", "agent:8TO");
		const holders = () =>
			frames.filter((f) => f.type === "huddle:floor").map((f) => (f as { holder: string }).holder);
		for (let i = 0; i < 60 && holders().length < 2; i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(holders()[1]).toBe("agent:8SO");
		m.close("human:local");
	});

	it("releases the floor when the holder is dropped", async () => {
		const { m, frames } = machine(["agent:8TO", "agent:8SO"]);
		m.open();
		for (let i = 0; i < 40 && !frames.some((f) => f.type === "huddle:floor"); i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		const first = frames.find((f) => f.type === "huddle:floor") as { holder: string; turnId: string };
		m.drop("human:local", first.holder);
		// Otherwise the room sits waiting on somebody who has left.
		const released = frames.filter((f) => f.type === "huddle:floor_released");
		expect(released.length).toBeGreaterThan(0);
		m.close("human:local");
	});
});
