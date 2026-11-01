/**
 * The folded trace (#5170), through Ink at 100 and 40 columns: the running turn's
 * steps sit behind one status row; opening shows today's rows; a finished turn
 * keeps its results; a turn a blocked step ended gets one plain sentence; with
 * the setting on, the rows are exactly today's.
 *
 * The rows-on-screen numbers for a six-tool turn, before and after, are printed
 * by the "measure" test and quoted in the PR.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render, renderToString } from "ink";
import type { Message } from "../../app.js";
import { blockedSentence, showStepsWhileWorking } from "../../lib/folded-trace.js";
import type { ToolTrailEntry } from "../../lib/tool-trail.js";
import { FoldedStatus } from "../FoldedStatus.js";
import { MessageList, estimateMessageRowsForTest } from "../message-list.js";

const at = new Date("2026-10-26T12:00:00Z");

const end = (n: number, entry: ToolTrailEntry): Message => ({
	id: `tool-end-${n}`,
	role: "tool",
	content: "  ✓",
	timestamp: at,
	toolTrail: { seq: n, ...entry },
});

const user: Message = {
	id: "u1",
	role: "user",
	content: "Find where the retry limit is set and raise it.",
	timestamp: at,
};

// Six calls, a reply-less running turn: what the person watches today.
const SIX: ToolTrailEntry[] = [
	{ tool: "list_files", summary: "packages/settings", status: "ok" },
	{ tool: "search_files", summary: "maxRetries", status: "ok" },
	{ tool: "read_file", summary: "packages/settings/retry.ts", status: "ok" },
	{ tool: "edit_file", summary: "packages/settings/retry.ts", status: "ok" },
	{ tool: "run_command", summary: "bun test packages/settings/retry.test.ts", status: "ok" },
	{ tool: "read_file", summary: "packages/settings/retry.test.ts", status: "ok" },
];

const running: Message[] = [user, ...SIX.map((e, i) => end(i + 1, e))];
const finished: Message[] = [
	...running,
	{ id: "a1", role: "assistant", content: "The retry limit is now 5.", timestamp: at },
];
const blockedFinish: Message[] = [
	user,
	end(1, SIX[0]),
	end(2, {
		tool: "write_file",
		summary: ".env",
		status: "blocked",
		reason: "blocked: [no-secrets]",
	}),
];

const asst = (id: string, content: string): Message => ({
	id,
	role: "assistant",
	content,
	timestamp: at,
});
const blockedCall: ToolTrailEntry = {
	tool: "write_file",
	summary: ".env",
	status: "blocked",
	reason: "blocked: [no-secrets]",
};
// An older turn a block ended with no reply, then a newer turn that finished fine.
const olderBlocked: Message[] = [
	user,
	end(1, SIX[0]),
	end(2, blockedCall),
	asst("a1", ""),
	{ ...user, id: "u2", content: "Try the other file." },
	end(3, SIX[2]),
	asst("a2", "Done, the other file is updated."),
];
// The last call was blocked, and the reply recovered in text.
const recovered: Message[] = [
	user,
	end(1, blockedCall),
	asst("a1", "I could not touch .env, so I kept the limit in settings instead."),
];

const MESSAGE_LIST_BANNED = [/SYSTEM ONE/i, /TOOLG8/i, /no-secrets/, /blocked:/];

function show(
	messages: Message[],
	cols: number,
	opts: { fold: boolean; open?: boolean; running?: boolean; liveTool?: string | null },
): string {
	return renderToString(
		<MessageList
			messages={messages}
			animateTyping={false}
			showAnimations={false}
			scrollEnabled={false}
			contentWidth={cols - 4}
			rowBudget={60}
			turnRunning={opts.running ?? true}
			foldTrace={opts.fold}
			traceOpen={opts.open ?? false}
			liveTool={opts.liveTool ?? null}
		/>,
		{ columns: cols },
	);
}

/**
 * message-list.tsx as it was before the PR, loaded from git (the merge-base with
 * origin/main) so "trace on" is held to what main really drew. It is written next
 * to the real one so its relative imports resolve, imported, then removed. Where
 * git cannot supply it (a shallow checkout), the test fails loudly rather than
 * comparing the new renderer with itself.
 */
async function baseMessageList(): Promise<typeof MessageList> {
	const here = dirname(new URL(import.meta.url).pathname);
	const sh = (args: string[]) => spawnSync("git", args, { cwd: here, encoding: "utf8" });
	const top = sh(["rev-parse", "--show-toplevel"]).stdout.trim();
	let base = "";
	for (const ref of ["origin/main", "main"]) {
		const r = sh(["merge-base", "HEAD", ref]);
		if (r.status === 0) {
			base = r.stdout.trim();
			break;
		}
	}
	if (!base) throw new Error("no merge-base with origin/main: fetch main to run this test");
	const src = sh(["show", `${base}:apps/tui/src/components/message-list.tsx`]);
	if (src.status !== 0) throw new Error("cannot read message-list.tsx at the merge-base");
	const file = join(top, "apps/tui/src/components", `message-list.base-${process.pid}.tmp.tsx`);
	writeFileSync(file, src.stdout);
	try {
		return (await import(file)).MessageList;
	} finally {
		if (existsSync(file)) unlinkSync(file);
	}
}

/** Rows the list takes: its lines, minus the blank ones at the end. */
function rowsOf(out: string): number {
	const lines = out.split("\n");
	while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
	return lines.length;
}

for (const cols of [100, 40]) {
	describe(`at ${cols} columns`, () => {
		test("folded: one status row, no per-step rows", () => {
			const out = show(running, cols, { fold: true });
			expect(out).toMatch(cols >= 60 ? /Working: .+ \(step 6, \d+s\)/ : /Enter: steps /);
			expect(out).not.toContain("search_files");
			expect(out).not.toContain("retry.ts");
			expect(out).not.toContain("✓ ");
			for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(cols + 4);
		});

		test("the phrase follows the running call, else the newest finished one", () => {
			expect(show(running, cols, { fold: true })).toContain(
				cols >= 60 ? "Working: reading files" : "Enter: steps reading files",
			);
			expect(show(running, cols, { fold: true, liveTool: "run_command" })).toContain(
				cols >= 60 ? "Working: running a check (step 7" : "Enter: steps running a check",
			);
			expect(show(running, cols, { fold: true, liveTool: "judge_check" })).toContain(
				"asking the judge",
			);
		});

		test("open: the full step list shows under the row, as today", () => {
			const before = show(running, cols, { fold: false });
			const open = show(running, cols, { fold: true, open: true });
			expect(open).toMatch(/▾ /);
			expect(open).toContain("Esc closes");
			expect(show(running, cols, { fold: true })).not.toContain("Esc closes");
			// Every row today's list shows, still shows.
			for (const line of before.split("\n").filter((l) => l.includes("✓"))) {
				expect(open).toContain(line.trim().replace(/^│\s*/, ""));
			}
			expect(rowsOf(open)).toBe(rowsOf(before) + 1);
		});

		test("EIGHT_TUI_TRACE=on: row for row what main drew before the PR", async () => {
			const Base = await baseMessageList();
			const foldTrace = !showStepsWhileWorking({ EIGHT_TUI_TRACE: "on" }, () => ({}) as never);
			expect(foldTrace).toBe(false);
			for (const [messages, isRunning] of [
				[running, true],
				[finished, false],
				[blockedFinish, false],
				[olderBlocked, false],
			] as const) {
				const props = {
					messages,
					animateTyping: false,
					showAnimations: false,
					scrollEnabled: false,
					contentWidth: cols - 4,
					rowBudget: 60,
					turnRunning: isRunning,
				};
				const main = renderToString(<Base {...props} />, { columns: cols });
				const now = renderToString(
					<MessageList {...props} foldTrace={foldTrace} traceOpen={false} liveTool={null} />,
					{ columns: cols },
				);
				expect(now.split("\n")).toEqual(main.split("\n"));
				expect(now).not.toContain("Working:");
			}
		});

		test("finish: the row becomes the answer, results as today", () => {
			const folded = show(finished, cols, { fold: true, running: false });
			const today = show(finished, cols, { fold: false, running: false });
			expect(folded).not.toContain("Working:");
			expect(folded).toContain("The retry limit is now 5.");
			expect(folded).toBe(today);
		});

		test("blocked finish: one plain sentence, never raw error text", () => {
			const out = show(blockedFinish, cols, { fold: true, running: false });
			const flat = out
				.split("\n")
				.map((l) => l.replace(/^│\s?/, "").trim())
				.join(" ");
			expect(flat).toContain(
				"A safety check stopped this while editing a file, so it did not run.",
			);
			expect(flat).toContain("Say so if you want it allowed");
			expect(flat).not.toMatch(/permission mode|Shift\+Tab/);
			// The results block still lists the step, as today; the sentence adds none of the gate's words.
			const sentence = blockedSentence([
				{ tool: "write_file", summary: "", status: "blocked", reason: "blocked: [no-secrets]" },
			]) as string;
			for (const re of MESSAGE_LIST_BANNED) expect(sentence).not.toMatch(re);
			// With the setting on, today's output: no sentence.
			const on = show(blockedFinish, cols, { fold: false, running: false });
			expect(on).not.toContain("A safety check stopped");
		});

		test("an older blocked turn shows no sentence", () => {
			const out = show(olderBlocked, cols, { fold: true, running: false });
			expect(out).toContain("Done, the other file is updated.");
			expect(out).not.toContain("A safety check stopped");
		});

		test("a blocked turn that recovered in text shows no sentence", () => {
			const out = show(recovered, cols, { fold: true, running: false });
			expect(out).toContain("I could not touch .env");
			expect(out).not.toContain("A safety check stopped");
		});

		test("the sentence waits for the turn to end", () => {
			expect(show(blockedFinish, cols, { fold: true, running: true })).not.toContain(
				"A safety check stopped",
			);
		});

		test("the row carries the hint under 60 columns, Esc closes when open", () => {
			const closed = show(running, cols, { fold: true });
			const open = show(running, cols, { fold: true, open: true });
			if (cols < 60) {
				expect(closed).toContain("▸ Enter: steps");
				expect(open).toContain("▾ Esc closes");
			} else {
				expect(closed).not.toContain("Enter: steps");
				expect(open).toContain("Esc closes");
			}
			for (const out of [closed, open]) {
				for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(cols + 4);
			}
		});

		test("the row estimate matches the rows Ink draws, folded and open", () => {
			const draw = (messages: Message[], o: { open?: boolean }) =>
				rowsOf(show(messages, cols, { fold: true, open: o.open }));
			const w = cols - 4;
			const trailItem = { ...running[1], id: "trail", role: "tool" as const, content: "" };
			const userRows = rowsOf(show([user], cols, { fold: true, running: true }));
			for (const open of [false, true]) {
				const est = estimateMessageRowsForTest(trailItem, w, SIX, { folded: true, open });
				// The estimate counts the item's own margin row; the render trims it.
				expect(draw(running, { open }) - userRows - 1).toBe(est - 1);
			}
		});
	});
}

describe("measure: rows on screen for a six-tool turn", () => {
	test("before and after at 100 and 40 columns", () => {
		const rows: Record<string, number> = {};
		for (const cols of [100, 40]) {
			// The person's own message is the same either way; count what the six calls add.
			const base = rowsOf(show([user], cols, { fold: true }));
			rows[`before@${cols}`] = rowsOf(show(running, cols, { fold: false })) - base;
			rows[`after@${cols}`] = rowsOf(show(running, cols, { fold: true })) - base;
			rows[`open@${cols}`] = rowsOf(show(running, cols, { fold: true, open: true })) - base;
			expect(rows[`before@${cols}`]).toBe(7);
			expect(rows[`after@${cols}`]).toBe(2);
			expect(rows[`open@${cols}`]).toBe(8);
		}
		console.log(
			`[folded-trace] rows the six calls take ${JSON.stringify(rows)}; keystrokes to the full trace: 1 (Enter)`,
		);
	});
});

describe("FoldedStatus", () => {
	function fakeStdout(cols: number) {
		const out = new EventEmitter() as EventEmitter & {
			columns: number;
			rows: number;
			isTTY: boolean;
			frames: string[];
			write: (s: string) => boolean;
		};
		out.columns = cols;
		out.rows = 24;
		out.isTTY = false;
		out.frames = [];
		out.write = (s: string) => {
			out.frames.push(s);
			return true;
		};
		return out;
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
	const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

	test("redraws in place at most twice a second", async () => {
		const stdout = fakeStdout(100);
		let clock = 0;
		const props = (trail: ToolTrailEntry[]) => ({
			trail,
			startedAt: 0,
			open: false,
			width: 90,
			now: () => clock,
		});
		const app = render(<FoldedStatus {...props(SIX.slice(0, 1))} />, {
			stdout: stdout as unknown as NodeJS.WriteStream,
			debug: true,
			patchConsole: false,
			exitOnCtrlC: false,
		});
		const last = () => plain(stdout.frames.at(-1) ?? "");
		expect(last()).toContain("Working: reading files (step 1, 0s)");
		// A call lands and time passes, but the row holds until the refresh.
		clock = 3000;
		app.rerender(<FoldedStatus {...props(SIX.slice(0, 4))} />);
		await new Promise((r) => setTimeout(r, 100));
		expect(last()).toContain("(step 1, 0s)");
		await new Promise((r) => setTimeout(r, 600));
		expect(last()).toContain("(step 4, 3s)");
		const frames = stdout.frames.length;
		// A 1.2 s window holds at most three draws of the row.
		await new Promise((r) => setTimeout(r, 1200));
		expect(stdout.frames.length - frames).toBeLessThanOrEqual(3);
		app.unmount();
	});

	test("one row, never wider than its width", () => {
		for (const width of [90, 36]) {
			const out = renderToString(
				<FoldedStatus trail={SIX} startedAt={0} open={false} width={width} now={() => 125_000} />,
				{ columns: 100 },
			);
			const lines = out.split("\n").filter((l) => l.trim() !== "");
			expect(lines.length).toBe(1);
			expect(lines[0]?.length).toBeLessThanOrEqual(width);
		}
	});
});
