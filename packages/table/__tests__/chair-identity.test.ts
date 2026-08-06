/**
 * The chair seat goes to the human who is actually THERE.
 *
 * The chair speaks last, and that seat exists to give the human the final word
 * after hearing everyone. It used to be granted to the literal CHAIR_HUMAN_ID
 * ("human:james"), while the Table pins its human as "human:local" unless
 * EIGHT_DAEMON_TOKEN is set - and it is not set on the reference machine.
 *
 * Measured live on 2026-08-06 against a real huddle on the daemon: chair
 * resolved to "human:james" while the only connected human was "human:local".
 * The officers speak, then the chair turn is granted to an id no client answers
 * to, and it sits unclaimed until the deadline. The seat the whole chair-last
 * design exists to serve was unreachable.
 *
 * Presence detection was never the bug - isHuman() is prefix-based and already
 * accepted any human:*. Only the identity handed the turn was hardcoded.
 */

import { describe, expect, it } from "bun:test";
import {
	CHAIR_AGENT_ID,
	CHAIR_HUMAN_ID,
	FloorMachine,
	type HuddleOpenConfig,
	type HuddleOutFrame,
} from "../floor";

function machineFor(openedBy: string, chairMode: "auto" | "human" | "agent") {
	const frames: HuddleOutFrame[] = [];
	const config: HuddleOpenConfig = {
		huddleId: `chair-${chairMode}-${openedBy}`,
		channelId: "chan-chair-test",
		openedBy,
		roster: [openedBy, "agent:8TO"],
		topic: "chair identity",
		chair: CHAIR_HUMAN_ID,
		chairMode,
		maxRounds: 1,
		maxDurationMs: 2_000,
		prepareBudgetMs: 20,
		speakMsOverride: 2,
	};
	const machine = new FloorMachine(config, {
		emit: (f) => frames.push(f),
		prepareAgentTurn: async () => "a short spoken turn",
	});
	return { machine, frames };
}

/** The chair id the machine actually resolved, from its own emitted frame. */
async function resolvedChair(openedBy: string, chairMode: "auto" | "human" | "agent") {
	const { machine, frames } = machineFor(openedBy, chairMode);
	machine.open();
	// Let the ring drain and the chair be granted.
	for (let i = 0; i < 60 && !frames.some((f) => f.type === "huddle:chair_resolved"); i++) {
		await new Promise((r) => setTimeout(r, 25));
	}
	const f = frames.find((x) => x.type === "huddle:chair_resolved") as
		| { chair: string; resolved: string; reason: string }
		| undefined;
	machine.close("human:test");
	return f;
}

describe("chair seat identity", () => {
	it("grants the chair to the human who is actually present, not a hardcoded name", async () => {
		// This is the regression. "human:local" is what the Table really pins.
		const f = await resolvedChair("human:local", "human");
		expect(f).toBeDefined();
		expect(f?.resolved).toBe("human");
		expect(f?.chair).toBe("human:local");
		expect(f?.chair).not.toBe(CHAIR_HUMAN_ID);
	});

	it("is unchanged when the canonical human is the one connected", async () => {
		// The fix must not move behaviour for the case that already worked.
		const f = await resolvedChair(CHAIR_HUMAN_ID, "human");
		expect(f?.chair).toBe(CHAIR_HUMAN_ID);
		expect(f?.resolved).toBe("human");
	});

	it("still hands the chair to the agent when explicitly asked", async () => {
		// chairMode "agent" is a deliberate choice (James away, AI James chairs)
		// and must not be affected by who happens to be present.
		const f = await resolvedChair("human:local", "agent");
		expect(f?.chair).toBe(CHAIR_AGENT_ID);
		expect(f?.resolved).toBe("agent");
	});
});
