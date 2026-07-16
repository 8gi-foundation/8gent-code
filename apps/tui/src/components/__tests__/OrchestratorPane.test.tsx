/**
 * OrchestratorPane tests - the meta-harness orchestrator view (part of #2797).
 *
 * Two layers:
 *   1. Pure pane: rows in, grid out. Headless Ink render (real reconciler,
 *      fake stdout, debug frames) asserts the actual terminal output - one
 *      row per task, state pill, harness/tool/tokens/elapsed columns, and
 *      the honest empty state.
 *   2. Live pane: OrchestratorPaneLive + useHarnessTasks against a fake
 *      StatusEventSource (same shape as packages/harness HarnessRunner:
 *      allEvents + subscribe) - buffered replay renders, live events update.
 *
 * The headless harness below is written from scratch for this repo (no
 * ink-testing-library dependency): an EventEmitter stdout that records
 * debug frames, and an inert stdin.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import type React from "react";
import {
	type Harness,
	HarnessRegistry,
	HarnessRunner,
	type HarnessTask,
	type StatusEvent,
} from "../../../../../packages/harness/index";
import type { StatusEventSource } from "../../hooks/useHarnessTasks";
import type { OrchestratorRow } from "../../lib/orchestrator-model";
import { OrchestratorPane, OrchestratorPaneLive, STATE_COLORS } from "../OrchestratorPane";

class FakeStdout extends EventEmitter {
	columns = 100;
	rows = 40;
	isTTY = true;
	frames: string[] = [];
	write = (frame: string): boolean => {
		this.frames.push(frame);
		return true;
	};
	lastFrame(): string {
		return this.frames.at(-1) ?? "";
	}
}

class FakeStdin extends EventEmitter {
	isTTY = false;
	setEncoding(): this {
		return this;
	}
	setRawMode(): this {
		return this;
	}
	resume(): this {
		return this;
	}
	pause(): this {
		return this;
	}
	ref(): this {
		return this;
	}
	unref(): this {
		return this;
	}
	read(): null {
		return null;
	}
}

function renderHeadless(element: React.ReactElement): {
	stdout: FakeStdout;
	unmount: () => void;
} {
	const stdout = new FakeStdout();
	const stdin = new FakeStdin();
	const instance = render(element, {
		// Structural fakes stand in for the real streams in headless tests.
		stdout: stdout as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	return { stdout, unmount: () => instance.unmount() };
}

/** Strip ANSI color codes so assertions read the visible text. */
function plain(frame: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping needs the escape byte
	return frame.replace(/\[[0-9;]*m/g, "");
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

function row(
	partial: Partial<OrchestratorRow> & Pick<OrchestratorRow, "id" | "state">,
): OrchestratorRow {
	return { harness: "8gent-local", startedTs: 1000, updatedTs: 1000, ...partial };
}

describe("OrchestratorPane", () => {
	test("exports component, live component, and state colors", () => {
		expect(typeof OrchestratorPane).toBe("function");
		expect(typeof OrchestratorPaneLive).toBe("function");
		const states = ["queued", "working", "blocked", "needs_input", "done", "error"] as const;
		for (const s of states) expect(STATE_COLORS[s]).toMatch(/^#[0-9A-Fa-f]{6}$/);
	});

	test("state colors avoid the banned purple/pink/violet band (hue 270-350)", () => {
		for (const hex of Object.values(STATE_COLORS)) {
			const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
			const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
			const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			if (max === min) continue; // achromatic
			let hue: number;
			if (max === r) hue = ((g - b) / (max - min)) % 6;
			else if (max === g) hue = (b - r) / (max - min) + 2;
			else hue = (r - g) / (max - min) + 4;
			hue = (hue * 60 + 360) % 360;
			expect(hue < 270 || hue > 350).toBe(true);
		}
	});

	test("honest empty state - no agents running", () => {
		const { stdout, unmount } = renderHeadless(<OrchestratorPane rows={[]} />);
		const frame = plain(stdout.lastFrame());
		expect(frame).toContain("ORCHESTRATOR");
		expect(frame).toContain("no agents running");
		unmount();
	});

	test("renders one row per task with state pill and key fields", () => {
		const rows: OrchestratorRow[] = [
			row({
				id: "hx_a1",
				state: "working",
				tool: "read_file",
				tokens: 12345,
				elapsedMs: 4200,
			}),
			row({ id: "hx_b2", state: "queued" }),
			row({
				id: "hx_c3",
				state: "done",
				harness: "8gent-local",
				tokens: 350,
				elapsedMs: 83_000,
				output: "all green",
			}),
		];
		const { stdout, unmount } = renderHeadless(<OrchestratorPane rows={rows} />);
		const frame = plain(stdout.lastFrame());
		// One line per task
		expect(frame).toContain("hx_a1");
		expect(frame).toContain("hx_b2");
		expect(frame).toContain("hx_c3");
		// State pills
		expect(frame).toContain("working");
		expect(frame).toContain("queued");
		expect(frame).toContain("done");
		// Key fields: harness, tool, tokens, elapsed
		expect(frame).toContain("8gent-local");
		expect(frame).toContain("read_file");
		expect(frame).toContain("12.3k");
		expect(frame).toContain("4.2s");
		expect(frame).toContain("1m23s");
		// Never-reported fields render as "-" (honesty), not invented numbers
		const queuedLine = frame.split("\n").find((l) => l.includes("hx_b2")) ?? "";
		expect(queuedLine).toContain("-");
		// Active count reflects non-terminal tasks only
		expect(frame).toContain("2 active");
		unmount();
	});

	// #2802: no row cap meant a 40-agent run rendered a 44-line pane that
	// pushed every sibling pane off-screen.
	test("caps rendered rows and shows an honest +N more line", () => {
		const rows: OrchestratorRow[] = Array.from({ length: 40 }, (_, i) =>
			row({ id: `hx_${String(i).padStart(2, "0")}`, state: "working" }),
		);
		const { stdout, unmount } = renderHeadless(<OrchestratorPane rows={rows} />);
		const frame = plain(stdout.lastFrame());
		const lines = frame.split("\n");
		// title + header + 10 rows + overflow line + 2 border lines
		expect(lines.length).toBeLessThanOrEqual(16);
		expect(frame).toContain("+30 more");
		expect(frame).toContain("40 active");
		unmount();
	});

	test("maxRows prop overrides the default cap", () => {
		const rows: OrchestratorRow[] = Array.from({ length: 8 }, (_, i) =>
			row({ id: `hx_${i}`, state: "working" }),
		);
		const { stdout, unmount } = renderHeadless(<OrchestratorPane rows={rows} maxRows={3} />);
		const frame = plain(stdout.lastFrame());
		expect(frame).toContain("+5 more");
		expect(frame.split("\n").length).toBeLessThanOrEqual(9);
		unmount();
	});

	// #2802: fixed 66-char column budget collided into an unreadable wall on
	// narrow terminals. Columns must drop responsively instead.
	test("narrow pane (40 cols) drops columns instead of colliding", () => {
		const rows: OrchestratorRow[] = [
			row({ id: "hx_work01", state: "working", tool: "read_file", tokens: 4500, elapsedMs: 3200 }),
			row({ id: "hx_queue1", state: "queued" }),
		];
		const { stdout, unmount } = renderHeadless(<OrchestratorPane rows={rows} width={40} />);
		const frame = plain(stdout.lastFrame());
		for (const line of frame.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(40);
		}
		// Dropped columns are gone, not mashed together.
		expect(frame).not.toContain("TOKENS");
		expect(frame).not.toContain("TOOLTOKENSELAPSED");
		expect(frame).toContain("AGENT");
		expect(frame).toContain("STATE");
		expect(frame).toContain("ELAPSED");
		expect(frame).toContain("3.2s");
		unmount();
	});

	test("very narrow pane (24 cols) keeps AGENT + STATE inside the border", () => {
		const rows: OrchestratorRow[] = [
			row({ id: "hx_work01", state: "working", tool: "read_file", tokens: 4500 }),
			row({ id: "hx_queue1", state: "queued" }),
		];
		const { stdout, unmount } = renderHeadless(<OrchestratorPane rows={rows} width={24} />);
		const frame = plain(stdout.lastFrame());
		for (const line of frame.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(24);
		}
		expect(frame).toContain("AGENT");
		expect(frame).toContain("STATE");
		expect(frame).toContain("working");
		expect(frame).toContain("queued");
		// The active count is dropped rather than mashed into the title
		// ("ORCHESTRATOR2 active") when the title row has no slack.
		expect(frame).not.toContain("ORCHESTRATOR2");
		unmount();
	});

	test("stable frame snapshot", () => {
		const rows: OrchestratorRow[] = [
			row({ id: "hx_a1", state: "working", tool: "bash", tokens: 900, elapsedMs: 950 }),
			row({ id: "hx_e9", state: "error", output: "boom" }),
		];
		const { stdout, unmount } = renderHeadless(<OrchestratorPane rows={rows} width={80} />);
		expect(plain(stdout.lastFrame())).toMatchSnapshot();
		unmount();
	});
});

describe("OrchestratorPaneLive", () => {
	function fakeSource(buffered: StatusEvent[]): {
		source: StatusEventSource;
		push: (e: StatusEvent) => void;
		listenerCount: () => number;
	} {
		const listeners = new Set<(e: StatusEvent) => void>();
		return {
			source: {
				allEvents: () => [...buffered],
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			push: (e) => {
				buffered.push(e);
				for (const l of listeners) l(e);
			},
			listenerCount: () => listeners.size,
		};
	}

	const ev = (
		partial: Partial<StatusEvent> & Pick<StatusEvent, "agentId" | "state">,
	): StatusEvent => ({
		harness: "8gent-local",
		ts: 1000,
		...partial,
	});

	test("replays buffered events on mount, then updates on live events", async () => {
		const { source, push } = fakeSource([
			ev({ agentId: "hx_1", state: "queued", ts: 1 }),
			ev({ agentId: "hx_1", state: "working", ts: 2, tool: "bash" }),
		]);
		const { stdout, unmount } = renderHeadless(<OrchestratorPaneLive source={source} />);
		await tick();
		let frame = plain(stdout.lastFrame());
		expect(frame).toContain("hx_1");
		expect(frame).toContain("working");
		expect(frame).toContain("bash");

		push(ev({ agentId: "hx_1", state: "done", ts: 3, output: "shipped", tokens: 500 }));
		await tick();
		frame = plain(stdout.lastFrame());
		expect(frame).toContain("done");
		expect(frame).toContain("500");
		unmount();
	});

	test("empty source renders the honest empty state and unsubscribes on unmount", async () => {
		const { source, listenerCount } = fakeSource([]);
		const { stdout, unmount } = renderHeadless(<OrchestratorPaneLive source={source} />);
		await tick();
		expect(plain(stdout.lastFrame())).toContain("no agents running");
		expect(listenerCount()).toBe(1);
		unmount();
		await tick();
		expect(listenerCount()).toBe(0);
	});

	test("a real HarnessRunner satisfies the source seam end-to-end", async () => {
		// Stub harness honors the stream contract: queued -> working -> done.
		const stub: Harness = {
			name: "stub",
			async *run(task: HarnessTask) {
				const base = { agentId: task.id, harness: "stub" };
				yield { ...base, state: "queued" as const, ts: Date.now() };
				yield {
					...base,
					state: "working" as const,
					tool: "write_file",
					tokens: 128,
					elapsedMs: 5,
					ts: Date.now(),
				};
				yield {
					...base,
					state: "done" as const,
					output: "stub finished",
					tokens: 256,
					elapsedMs: 12,
					ts: Date.now(),
				};
			},
		};
		const registry = new HarnessRegistry();
		registry.register(stub);
		const runner = new HarnessRunner(registry);

		const { stdout, unmount } = renderHeadless(<OrchestratorPaneLive source={runner} />);
		const taskId = runner.start({ prompt: "do the thing", harness: "stub" });
		await tick();
		await tick();
		const frame = plain(stdout.lastFrame());
		expect(frame).toContain(taskId.slice(0, 8));
		expect(frame).toContain("done");
		expect(frame).toContain("stub");
		expect(frame).toContain("write_file");
		expect(frame).toContain("256");
		expect(frame).toContain("12ms");
		expect(frame).toContain("0 active");
		unmount();
	});
});
