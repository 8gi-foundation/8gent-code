/**
 * Harness for thinking-scope.test.tsx (#3918 D3, D4, D10). In the real App,
 * with a provider that lists two models:
 * - /thinking shows the level; /thinking high is clamped by the provider;
 *   Ctrl+Z cycles it; /thinking hide and show set the display;
 * - /scoped-models shows the scope; Alt+M cycles every listed model until a
 *   scope is set, then only the scope; /scoped-models clear resets it;
 * - /status reports the thinking level.
 */
import { bootApp, finish, tick, waitFor } from "./app-driver.js";
import { frameOf, recorder } from "./cast.js";

let screen: (() => string) | null = null;

async function main() {
	// 80 rows: the whole /hotkeys table fits on one screen.
	const app = await bootApp(160, 80);
	screen = () => frameOf(app);
	const rec = recorder(app);

	let m = await app.submit("/thinking");
	await waitFor(() => app.since(m).includes("Thinking: off."), "/thinking");
	app.emit({ phase: "thinking-show", screen: app.since(m) });
	rec.take("/thinking");

	m = await app.submit("/thinking high");
	await waitFor(() => app.since(m).includes("Thinking: high requested."), "/thinking high");
	app.emit({ phase: "thinking-high", screen: app.since(m) });
	rec.take("/thinking high (clamped by the provider)");

	m = await app.submit("/thinking max");
	await waitFor(() => app.since(m).includes('Unknown thinking level "max"'), "/thinking max");

	// Ctrl+Z from high wraps to off, then low.
	m = app.mark();
	app.feed("\x1a");
	await waitFor(() => app.since(m).includes("Thinking: off."), "Ctrl+Z to off");
	// Ink re-subscribes its key handler after a render; let it before the next press.
	await tick(300);
	m = app.mark();
	app.feed("\x1a");
	await waitFor(() => app.since(m).includes("Thinking: low requested."), "Ctrl+Z to low");
	app.emit({ phase: "cycle", ok: true });
	rec.take("Ctrl+Z cycled off, low");

	m = await app.submit("/thinking hide");
	await waitFor(() => app.since(m).includes("Thinking hidden. Ctrl+V shows it."), "/thinking hide");
	m = await app.submit("/status");
	await waitFor(() => app.since(m).includes("Thinking: low (hidden)"), "/status thinking line");
	app.emit({ phase: "status", screen: app.since(m) });
	rec.take("/status after /thinking hide");
	m = await app.submit("/thinking show");
	await waitFor(() => app.since(m).includes("Thinking shown. Ctrl+V hides it."), "/thinking show");

	// D3: no scope, Alt+M cycles every listed model.
	m = await app.submit("/scoped-models");
	await waitFor(
		() => app.since(m).includes("No scope set: Alt+M cycles all 2 listed models."),
		"/scoped-models empty",
	);
	rec.take("/scoped-models with no scope");
	// The App booted with model "none", so the first press lands on the first listed model.
	for (const expected of ["shell-test:1b (1/2)", "shell-test:2b (2/2)", "shell-test:1b (1/2)"]) {
		m = app.mark();
		app.feed("\x1bm"); // Alt+M
		await waitFor(
			() => app.since(m).includes(`Model switched to: ${expected}`),
			`Alt+M to ${expected}`,
		);
		await tick(300);
	}
	rec.take("Alt+M cycled 1b, 2b, then back to 1b");

	m = await app.submit("/scoped-models 2b nope");
	await waitFor(() => app.since(m).includes("Not listed by ollama: nope."), "unknown reported");
	await waitFor(() => app.since(m).includes("Scoped models (Alt+M cycles them):"), "scope set");
	app.emit({ phase: "scope-set", screen: app.since(m) });
	rec.take("/scoped-models 2b nope");
	m = app.mark();
	app.feed("\x1bm");
	await waitFor(
		() => app.since(m).includes("Model switched to: shell-test:2b (1/1 scoped)"),
		"Alt+M into scope",
	);
	await tick(300);
	m = app.mark();
	app.feed("\x1bm");
	await waitFor(
		() => app.since(m).includes("Only one model in scope: shell-test:2b."),
		"Alt+M stays in scope",
	);
	app.emit({ phase: "scope-cycle", ok: true });
	rec.take("Alt+M inside the scope");
	m = await app.submit("/scoped-models clear");
	await waitFor(
		() => app.since(m).includes("Scope cleared: Alt+M cycles all 2 listed models."),
		"scope cleared",
	);
	rec.take("/scoped-models clear");

	m = await app.submit("/hotkeys");
	await waitFor(() => app.since(m).includes("Keyboard shortcuts:"), "/hotkeys");
	await tick(300);
	app.emit({ phase: "hotkeys", screen: app.since(m) });
	rec.take("/hotkeys");
	app.emit({ phase: "frames", frames: rec.frames });
	await finish(0);
}

main().catch((e) => {
	process.stdout.write(
		`\n${JSON.stringify({ phase: "error", message: String(e?.message ?? e), screen: screen?.() })}\n`,
	);
	return finish(1);
});
