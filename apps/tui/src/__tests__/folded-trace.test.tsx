/**
 * The folded trace (#5170) in the real App, at 100 and 40 columns, with a scripted
 * model that makes six calls in a row: one status row while it runs, Enter opens the
 * full list in place and folds it again, Esc folds without stopping the turn, the
 * finished turn is its answer. With EIGHT_TUI_TRACE=on the rows show as before.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { serveScriptedModel } from "./scripted-model.js";

// The loop guard stops a run of the same call, so each read names its own file.
const FILES = [
	"README.md",
	"package.json",
	"BRAND.md",
	"CONVENTIONS.md",
	"PRIMARY_COLORS.md",
	"tsconfig.json",
];

const call = (n: number) =>
	[
		`Reading file ${n}.`,
		"```tool_call",
		`{"name": "read_file", "arguments": {"path": "${FILES[n - 1]}"}}`,
		"```",
	].join("\n");

function script() {
	return [
		...[1, 2, 3, 4, 5, 6].flatMap((n) => [{ reply: call(n), delayMs: 1500 }]),
		{ reply: "DONE: ALL_SIX_DONE, the six files are read." },
		{ reply: "DONE: ALL_SIX_DONE, the six files are read." },
	];
}

async function run(cols: number, extra: Record<string, string> = {}) {
	const model = serveScriptedModel(script());
	try {
		return await runAppHarness(
			path.join(import.meta.dir, "folded-trace.harness.tsx"),
			{ ...model.env, FOLD_COLS: String(cols), ...extra },
			120_000,
		);
	} finally {
		model.stop();
	}
}

const find = (events: Record<string, unknown>[], phase: string) =>
	events.find((e) => e.phase === phase);

for (const cols of [100, 40]) {
	test(`folded by default at ${cols} columns: status row, Enter opens, Enter or Esc folds`, async () => {
		const events = await run(cols);
		expect(find(events, "error")).toBeUndefined();
		const folded = find(events, "folded");
		expect(folded?.statusRows).toBe(1);
		expect(folded?.callRows).toBe(0);
		expect(String(folded?.frame)).toMatch(cols >= 60 ? /Working: / : /Enter: steps/);
		const open = find(events, "open");
		expect(Number(open?.callRows)).toBeGreaterThanOrEqual(1);
		expect(find(events, "refolded")?.ok).toBeTrue();
		expect(find(events, "esc-folds")?.stillRunning).toBeTrue();
		const done = find(events, "finished");
		expect(done?.hasAnswer).toBeTrue();
		expect(done?.hasStatusRow).toBeFalse();
		if (cols >= 80) {
			expect(folded?.footerHint).toBeTrue();
			expect(open?.footerHint).toBeTrue();
		}
		console.log(
			`[folded-trace.app@${cols}] call rows folded=${folded?.callRows} open=${open?.callRows}; footer hint shown=${folded?.footerHint}`,
		);
	}, 130_000);
}

test("with EIGHT_TUI_TRACE=on the per-call rows show and there is no status row", async () => {
	const events = await run(100, { EIGHT_TUI_TRACE: "on" });
	expect(find(events, "error")).toBeUndefined();
	const on = find(events, "setting-on");
	expect(Number(on?.callRows)).toBeGreaterThanOrEqual(2);
	expect(on?.hasStatusRow).toBeFalse();
	expect(on?.footerHint).toBeFalse();
	expect(find(events, "finished")?.hasAnswer).toBeTrue();
}, 130_000);
