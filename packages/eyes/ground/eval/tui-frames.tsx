/**
 * Render real 8gent TUI components headless (Ink's own reconciler, a fake
 * TTY) and turn each ANSI frame into a terminal-styled HTML page, so the
 * grounding eval can screenshot the TUI exactly as a terminal would draw it.
 * Target strings are wrapped in <span data-t="k"> so the browser can measure
 * their boxes. Frames are monochrome: chalk reads FORCE_COLOR at import, before
 * this module could set it, so colour depends on the calling shell.
 */
import { EventEmitter } from "node:events";
import { render } from "ink";
import type React from "react";
import { CommandPaletteView } from "../../../../apps/tui/src/components/CommandPalette.js";
import { InlineApprovalPrompt } from "../../../../apps/tui/src/components/InlineApprovalPrompt.js";
import { OrchestratorPane } from "../../../../apps/tui/src/components/OrchestratorPane.js";

class FakeStdout extends EventEmitter {
	columns = 100;
	rows = 30;
	isTTY = true;
	frames: string[] = [];
	write = (f: string) => {
		this.frames.push(f);
		return true;
	};
}
class FakeStdin extends EventEmitter {
	isTTY = false;
	setEncoding() {
		return this;
	}
	setRawMode() {
		return this;
	}
	resume() {
		return this;
	}
	pause() {
		return this;
	}
	ref() {
		return this;
	}
	unref() {
		return this;
	}
	read() {
		return null;
	}
}

async function frameOf(el: React.ReactElement): Promise<string> {
	const stdout = new FakeStdout();
	const inst = render(el, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await new Promise((r) => setTimeout(r, 30));
	const frame = stdout.frames.at(-1) ?? "";
	inst.unmount();
	return frame;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Cell {
	ch: string;
	style: string;
}

/** Parse ANSI SGR (truecolor fg, bold, resets) into styled characters. */
function cells(frame: string): Cell[] {
	const out: Cell[] = [];
	let fg = "";
	let bold = false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI parsing needs the escape byte
	const re = /\x1b\[([0-9;]*)m/g;
	let last = 0;
	const push = (text: string) => {
		const style = `${fg ? `color:${fg};` : ""}${bold ? "font-weight:700;" : ""}`;
		for (const ch of text) out.push({ ch, style });
	};
	for (let m = re.exec(frame); m; m = re.exec(frame)) {
		push(frame.slice(last, m.index));
		last = re.lastIndex;
		const codes = m[1].split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const c = codes[i];
			if (c === 0) {
				fg = "";
				bold = false;
			} else if (c === 1) bold = true;
			else if (c === 22) bold = false;
			else if (c === 39) fg = "";
			else if (c === 38 && codes[i + 1] === 2) {
				fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
				i += 4;
			}
		}
	}
	push(frame.slice(last));
	return out;
}

/** Styled HTML for a frame; each target's first occurrence in the visible text is wrapped in data-t="k". */
export function ansiToHtml(frame: string, targets: string[] = []): string {
	const cs = cells(frame.replace(/^\n/, ""));
	const plain = cs.map((c) => c.ch).join("");
	const open = new Map<number, number>();
	const close = new Set<number>();
	targets.forEach((t, k) => {
		const i = plain.indexOf(t);
		if (i < 0) throw new Error(`tui target not in frame: ${t}`);
		open.set(i, k);
		close.add(i + t.length - 1);
	});
	let html = "";
	cs.forEach((c, i) => {
		if (open.has(i)) html += `<span data-t="${open.get(i)}">`;
		html += c.style ? `<span style="${c.style}">${esc(c.ch)}</span>` : esc(c.ch);
		if (close.has(i)) html += "</span>";
	});
	return html;
}

export function terminalPage(body: string, dark = true): string {
	const bg = dark ? "#11131a" : "#fbfaf7";
	const fg = dark ? "#d8dae0" : "#24262b";
	return `<!doctype html><meta charset=utf-8><title>8gent</title><body style="margin:0;background:${bg};color:${fg}"><pre style="margin:0;padding:18px 22px;font:15px/1.35 Menlo,monospace">${body}</pre>`;
}

export interface TuiFrame {
	id: string;
	html: string;
	targets: { instruction: string; selector: string }[];
}

export async function tuiFrames(): Promise<TuiFrame[]> {
	const commands = [
		{ name: "voice", description: "Talk to 8gent" },
		{ name: "kanban", description: "Open the task board" },
		{ name: "predict", description: "Predict the next step" },
		{ name: "model", description: "Switch the active model" },
		{ name: "memory", description: "Search what 8gent remembers" },
	];
	const approve = await frameOf(
		<InlineApprovalPrompt target="write packages/eyes/ground/index.ts" />,
	);
	const palette = await frameOf(
		<CommandPaletteView query="" activeIndex={1} commands={commands} />,
	);
	const pane = await frameOf(
		<OrchestratorPane
			width={96}
			rows={[
				{
					id: "t-41",
					harness: "8gent-local",
					state: "working",
					tool: "read_file",
					tokens: 5120,
					startedTs: 1,
					updatedTs: 2,
				},
				{
					id: "t-42",
					harness: "claude",
					state: "blocked",
					tool: "run_command",
					tokens: 980,
					startedTs: 1,
					updatedTs: 2,
				},
				{
					id: "t-43",
					harness: "8gent-local",
					state: "done",
					output: "tests pass",
					startedTs: 1,
					updatedTs: 2,
				},
			]}
		/>,
	);
	const mk = (id: string, frame: string, t: [string, string][], dark = true): TuiFrame => ({
		id,
		html: terminalPage(
			ansiToHtml(
				frame,
				t.map((x) => x[0]),
			),
			dark,
		),
		targets: t.map(([, instruction], k) => ({ instruction, selector: `[data-t="${k}"]` })),
	});
	return [
		mk("tui-approval", approve, [
			["[Y] approve", "the Y approve option in the approval prompt"],
			["[N] deny", "the N deny option"],
		]),
		mk(
			"tui-approval-light",
			approve,
			[
				["[E] edit", "the E edit option"],
				["[S] skip", "the S skip option"],
			],
			false,
		),
		mk("tui-palette", palette, [
			["/kanban", "the kanban command in the command palette"],
			["/model", "the model command"],
		]),
		mk("tui-orchestrator", pane, [
			["t-42", "the row for task t-42"],
			["t-43", "the task t-43 row"],
		]),
	];
}
