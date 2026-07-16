/**
 * orchestrator-model tests - the pure fold that turns the meta-harness
 * StatusEvent stream (packages/harness) into one row per agent task, plus
 * the display formatters used by the OrchestratorPane.
 *
 * Honesty rules under test: tool/tokens/elapsedMs on a row are only ever
 * values a real StatusEvent carried; a later event without them must not
 * erase the last reported value, and nothing is ever invented.
 */

import { describe, expect, test } from "bun:test";
import type { StatusEvent } from "../../../../packages/harness/index";
import {
	type OrchestratorRow,
	foldStatusEvent,
	foldStatusEvents,
	formatElapsed,
	formatTokens,
	layoutColumns,
	selectVisibleRows,
} from "./orchestrator-model";

function ev(partial: Partial<StatusEvent> & Pick<StatusEvent, "agentId" | "state">): StatusEvent {
	return { harness: "8gent-local", ts: 1000, ...partial };
}

describe("foldStatusEvent", () => {
	test("first event for a task appends a row", () => {
		const rows = foldStatusEvent([], ev({ agentId: "hx_1", state: "queued", ts: 500 }));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			id: "hx_1",
			harness: "8gent-local",
			state: "queued",
			startedTs: 500,
			updatedTs: 500,
		});
	});

	test("later event for the same task updates the row in place", () => {
		let rows: OrchestratorRow[] = [];
		rows = foldStatusEvent(rows, ev({ agentId: "hx_1", state: "queued", ts: 500 }));
		rows = foldStatusEvent(
			rows,
			ev({ agentId: "hx_1", state: "working", ts: 800, elapsedMs: 300 }),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("working");
		expect(rows[0]?.elapsedMs).toBe(300);
		expect(rows[0]?.startedTs).toBe(500);
		expect(rows[0]?.updatedTs).toBe(800);
	});

	test("tasks keep arrival order", () => {
		let rows: OrchestratorRow[] = [];
		rows = foldStatusEvent(rows, ev({ agentId: "hx_a", state: "queued" }));
		rows = foldStatusEvent(rows, ev({ agentId: "hx_b", state: "queued" }));
		rows = foldStatusEvent(rows, ev({ agentId: "hx_a", state: "working" }));
		expect(rows.map((r) => r.id)).toEqual(["hx_a", "hx_b"]);
	});

	test("tool/tokens survive an event that does not carry them", () => {
		let rows: OrchestratorRow[] = [];
		rows = foldStatusEvent(rows, ev({ agentId: "hx_1", state: "working", tool: "read_file" }));
		rows = foldStatusEvent(
			rows,
			ev({ agentId: "hx_1", state: "working", tokens: 420, elapsedMs: 900 }),
		);
		expect(rows[0]?.tool).toBe("read_file");
		expect(rows[0]?.tokens).toBe(420);
	});

	test("fields never reported stay absent - nothing is invented", () => {
		const rows = foldStatusEvent([], ev({ agentId: "hx_1", state: "working" }));
		expect(rows[0]?.tool).toBeUndefined();
		expect(rows[0]?.tokens).toBeUndefined();
		expect(rows[0]?.elapsedMs).toBeUndefined();
		expect(rows[0]?.output).toBeUndefined();
	});

	test("terminal done event records output and tokens", () => {
		let rows: OrchestratorRow[] = [];
		rows = foldStatusEvent(rows, ev({ agentId: "hx_1", state: "working", tokens: 100 }));
		rows = foldStatusEvent(
			rows,
			ev({
				agentId: "hx_1",
				state: "done",
				output: "all green",
				tokens: 350,
				elapsedMs: 4000,
				ts: 5000,
			}),
		);
		expect(rows[0]?.state).toBe("done");
		expect(rows[0]?.output).toBe("all green");
		expect(rows[0]?.tokens).toBe(350);
	});

	test("re-folding the same event is idempotent (replay + live overlap)", () => {
		const e = ev({ agentId: "hx_1", state: "working", tokens: 42, ts: 700 });
		const once = foldStatusEvent([], e);
		const twice = foldStatusEvent(once, e);
		expect(twice).toEqual(once);
	});

	test("does not mutate the input array", () => {
		const rows = foldStatusEvent([], ev({ agentId: "hx_1", state: "queued" }));
		const before = structuredClone(rows);
		foldStatusEvent(rows, ev({ agentId: "hx_1", state: "working" }));
		expect(rows).toEqual(before);
	});
});

describe("foldStatusEvents", () => {
	test("folds a buffered history into rows", () => {
		const rows = foldStatusEvents([
			ev({ agentId: "hx_1", state: "queued", ts: 1 }),
			ev({ agentId: "hx_1", state: "working", ts: 2, tool: "bash" }),
			ev({ agentId: "hx_2", state: "queued", ts: 3 }),
			ev({ agentId: "hx_1", state: "done", ts: 4, output: "ok" }),
		]);
		expect(rows.map((r) => [r.id, r.state])).toEqual([
			["hx_1", "done"],
			["hx_2", "queued"],
		]);
		expect(rows[0]?.tool).toBe("bash");
	});
});

describe("formatTokens", () => {
	test("dash when never reported", () => {
		expect(formatTokens(undefined)).toBe("-");
	});
	test("plain under 1k", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(950)).toBe("950");
	});
	test("k over 1k", () => {
		expect(formatTokens(12345)).toBe("12.3k");
	});
	test("M over 1m", () => {
		expect(formatTokens(2_400_000)).toBe("2.4M");
	});
	// #2801: k values that would display as "1000.0k" must promote to M.
	test("k/M boundary promotes to M instead of 1000.0k", () => {
		expect(formatTokens(999_950)).toBe("1.0M");
		expect(formatTokens(999_999)).toBe("1.0M");
	});
	test("just below the promote threshold stays in k", () => {
		expect(formatTokens(999_949)).toBe("999.9k");
	});
});

describe("formatElapsed", () => {
	test("dash when never reported", () => {
		expect(formatElapsed(undefined)).toBe("-");
	});
	test("ms under a second", () => {
		expect(formatElapsed(950)).toBe("950ms");
	});
	test("seconds under a minute", () => {
		expect(formatElapsed(4200)).toBe("4.2s");
	});
	test("minutes and seconds above a minute", () => {
		expect(formatElapsed(83_000)).toBe("1m23s");
	});
	// #2801: a sub-minute remainder that rounds to 60 must carry into the
	// next minute - never an invalid clock like "1m60s".
	test("seconds remainder that rounds to 60 carries to the next minute", () => {
		expect(formatElapsed(119_988)).toBe("2m00s");
		expect(formatElapsed(179_988)).toBe("3m00s");
		expect(formatElapsed(239_988)).toBe("4m00s");
	});
	test("just under a minute that would display 60.0s carries to 1m00s", () => {
		expect(formatElapsed(59_988)).toBe("1m00s");
	});
	test("exact minute boundary", () => {
		expect(formatElapsed(60_000)).toBe("1m00s");
		expect(formatElapsed(120_000)).toBe("2m00s");
	});
});

describe("layoutColumns (#2802)", () => {
	test("wide pane keeps all six columns in display order", () => {
		expect(layoutColumns(100).map((c) => c.label)).toEqual([
			"AGENT",
			"STATE",
			"HARNESS",
			"TOOL",
			"TOKENS",
			"ELAPSED",
		]);
	});
	test("mid width drops to AGENT/STATE/ELAPSED", () => {
		expect(layoutColumns(40).map((c) => c.label)).toEqual(["AGENT", "STATE", "ELAPSED"]);
	});
	test("very narrow pane degrades to AGENT + STATE with a shrunk id column", () => {
		const cols = layoutColumns(24);
		expect(cols.map((c) => c.label)).toEqual(["AGENT", "STATE"]);
	});
	test("columns always fit inside the pane chrome at width >= 23", () => {
		for (let width = 23; width <= 120; width++) {
			const cols = layoutColumns(width);
			expect(cols.length).toBeGreaterThanOrEqual(2);
			const content = cols.reduce((sum, c) => sum + c.width + 1, 0);
			expect(content).toBeLessThanOrEqual(width - 4);
		}
	});
});

describe("selectVisibleRows (#2802)", () => {
	const mk = (id: string, state: OrchestratorRow["state"]): OrchestratorRow => ({
		id,
		harness: "8gent-local",
		state,
		startedTs: 1000,
		updatedTs: 1000,
	});

	test("no overflow returns all rows with hidden 0", () => {
		const rows = [mk("a", "working"), mk("b", "queued")];
		expect(selectVisibleRows(rows, 10)).toEqual({ visible: rows, hidden: 0 });
	});
	test("caps to maxRows and reports the hidden count", () => {
		const rows = Array.from({ length: 40 }, (_, i) => mk(`hx_${i}`, "working"));
		const { visible, hidden } = selectVisibleRows(rows, 10);
		expect(visible).toHaveLength(10);
		expect(hidden).toBe(30);
	});
	test("active rows are kept over older terminal rows, display order preserved", () => {
		const rows = [
			mk("done1", "done"),
			mk("act1", "working"),
			mk("done2", "error"),
			mk("act2", "queued"),
			mk("done3", "done"),
		];
		const { visible, hidden } = selectVisibleRows(rows, 3);
		expect(visible.map((r) => r.id)).toEqual(["act1", "act2", "done3"]);
		expect(hidden).toBe(2);
	});
});
