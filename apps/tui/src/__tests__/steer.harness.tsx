/**
 * Harness for steer.test.tsx (#3918 D1, D10). In the real App, against a
 * scripted model that holds each turn open:
 * - Enter while a turn runs steers it: the text lands after the tool call
 *   running now (the test reads the next request body);
 * - Ctrl+Q queues a follow-up that goes after the turn;
 * - Esc stops the turn and hands the queued text (a steer the turn never took
 *   and an Alt+Enter follow-up) back to the input;
 * - Ctrl+V toggles the thinking display (its line; the bubbles themselves
 *   only exist on the native tool path, see visibleMessages).
 * Emits JSON lines and, last, the frames it captured.
 */
import { bootApp, finish, tick, waitFor } from "./app-driver.js";
import { frameOf, recorder } from "./cast.js";

let screen: (() => string) | null = null;

async function main() {
	const app = await bootApp(160, 44);
	screen = () => frameOf(app);
	const rec = recorder(app);
	rec.take("ready");

	// Turn 1: the model's first reply is a tool call held open for a few
	// seconds. The person types while it is in flight.
	let m = await app.submit("read the colours file");
	await waitFor(() => app.since(m).includes("Steer the task"), "running placeholder");
	await tick(300);
	rec.take("turn running: Enter steers");
	m = await app.submit("STEER_NOW also count the lines");
	await waitFor(() => app.since(m).includes("Steering: it reaches the model"), "steer line");
	app.emit({ phase: "steer", ok: true });
	rec.take("steer accepted");

	// Ctrl+Q queues a follow-up for after the turn.
	m = app.mark();
	app.feed("FOLLOW_UP_LATER please");
	await waitFor(() => app.since(m).includes("FOLLOW_UP_LATER"), "typed follow-up");
	await tick(100);
	m = app.mark();
	app.feed("\x11"); // Ctrl+Q
	await waitFor(
		() => app.since(m).includes("Queued. It sends when the current task finishes."),
		"queued line",
	);
	app.emit({ phase: "followup", ok: true });
	rec.take("Ctrl+Q queued a follow-up");

	await waitFor(() => app.since(m).includes("FIRST_DONE"), "turn 1 reply", 30000);
	// The queued follow-up runs as turn 2.
	await waitFor(() => app.since(m).includes("FOLLOWUP_DONE"), "turn 2 reply", 30000);
	await tick(500);
	rec.take("turn 1 and the follow-up answered");
	app.emit({ phase: "turns", screen: app.since(m) });

	// D10: Ctrl+V hides the model's thinking bubbles and shows them again.
	// (On the text-tool path the engine passes no step text to the TUI, so
	// there is no bubble to hide here; the key and its line are what is proved.)
	m = app.mark();
	app.feed("\x16"); // Ctrl+V
	await waitFor(() => app.since(m).includes("Thinking hidden. Ctrl+V shows it."), "hidden line");
	await tick(300);
	rec.take("Ctrl+V: thinking hidden");
	m = app.mark();
	app.feed("\x16");
	await waitFor(() => app.since(m).includes("Thinking shown. Ctrl+V hides it."), "shown line");
	await tick(300);
	app.emit({ phase: "thinking-toggle", ok: true });
	rec.take("Ctrl+V: thinking shown again");

	// Turn 3: a steer the turn never takes (no tool call: the model is already
	// answering) and an Alt+Enter follow-up, then Esc. Both come back.
	m = await app.submit("second task");
	await waitFor(() => app.since(m).includes("Steer the task"), "turn 3 running");
	await tick(200);
	m = await app.submit("BRING_ME_BACK");
	await waitFor(() => app.since(m).includes("Steering: it reaches the model"), "steer 2 line");
	m = app.mark();
	app.feed("AND_ME_TOO");
	await waitFor(() => app.since(m).includes("AND_ME_TOO"), "typed alt-enter text");
	await tick(100);
	m = app.mark();
	app.feed("\x1b\r"); // Alt+Enter
	await waitFor(
		() => app.since(m).includes("Queued. It sends when the current task finishes."),
		"alt-enter queued",
	);
	rec.take("turn running: a steer and an Alt+Enter follow-up wait");
	m = app.mark();
	app.feed("\x1b"); // Esc
	await waitFor(
		() => app.since(m).includes("Generation interrupted. 2 queued messages are back in the input."),
		"esc restore line",
	);
	await tick(400);
	const after = app.since(m);
	rec.take("Esc: queued text back in the input");
	app.emit({
		phase: "esc",
		restoredFirst: after.includes("BRING_ME_BACK"),
		restoredSecond: after.includes("AND_ME_TOO"),
	});
	// Give the abandoned model reply time to arrive: nothing should run on it.
	await tick(5000);
	app.emit({ phase: "after-esc", screen: app.since(m) });
	app.emit({ phase: "frames", frames: rec.frames });
	await finish(0);
}

main().catch((e) => {
	process.stdout.write(
		`\n${JSON.stringify({ phase: "error", message: String(e?.message ?? e), screen: screen?.() })}\n`,
	);
	return finish(1);
});
