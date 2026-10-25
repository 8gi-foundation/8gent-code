/**
 * /thinking, Ctrl+Z, Ctrl+V, /scoped-models and Alt+M in the real App
 * (#3918 D3, D4, D10). The frames are written as an asciicast under $TMPDIR.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { type Frame, castPath, writeCast } from "./cast.js";
import { serveScriptedModel } from "./scripted-model.js";

test("/thinking and Ctrl+Z set the level the provider clamps; /scoped-models and Alt+M cycle models", async () => {
	const model = serveScriptedModel([{ reply: "unused" }], ["shell-test:1b", "shell-test:2b"]);
	try {
		const events = await runAppHarness(
			path.join(import.meta.dir, "thinking-scope.harness.tsx"),
			model.env,
			100_000,
		);
		const frames = (events.find((e) => e.phase === "frames")?.frames ?? []) as Frame[];
		const cast = castPath("pi-tui-d3-d4-thinking-scoped-models");
		writeCast(cast, frames, 160, 80, "8gent Code: /thinking, Ctrl+Z, /scoped-models, Alt+M");
		console.log(`[thinking-scope.test] ${frames.length} frames -> ${cast}`);

		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		expect(frames.length).toBeGreaterThan(0);
		const high = String(events.find((e) => e.phase === "thinking-high")?.screen ?? "");
		expect(high).toContain("ollama supports no thinking levels, so turns run without it");
		expect(events.find((e) => e.phase === "cycle")?.ok).toBeTrue();
		expect(String(events.find((e) => e.phase === "status")?.screen ?? "")).toContain(
			"Thinking: low (hidden)",
		);
		const scope = String(events.find((e) => e.phase === "scope-set")?.screen ?? "");
		expect(scope).toContain("  shell-test:2b");
		expect(scope).not.toContain("  shell-test:1b\n");
		expect(events.find((e) => e.phase === "scope-cycle")?.ok).toBeTrue();
		const hotkeys = String(events.find((e) => e.phase === "hotkeys")?.screen ?? "");
		for (const key of ["Alt+Enter", "Ctrl+Q", "Alt+M", "Ctrl+Z", "Ctrl+V"])
			expect(hotkeys).toContain(key);
		// No turn ran: every command was handled in the TUI.
		expect(model.requests.length).toBe(0);
	} finally {
		model.stop();
	}
}, 130_000);
