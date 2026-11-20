import { bootApp, finish, tick, waitFor } from "./app-driver.js";
/**
 * Harness for idle-submit.test.tsx (#178). In the real App, against a scripted
 * model: a turn ends (provider error, Esc, rebuild of the tab's engine mid-turn),
 * then a message is typed while nothing runs. It must start a turn and the
 * steering line must not print. IDLE_SCENARIO picks the way the turn ends.
 */
import { frameOf } from "./cast.js";

const STEERING = "Steering: it reaches the model";

async function main() {
	const scenario = process.env.IDLE_SCENARIO ?? "error";
	const app = await bootApp(160, 44);
	let m = await app.submit("first question");
	if (scenario === "error") {
		await tick(20000);
	} else {
		await waitFor(() => app.since(m).includes("Enter steers."), "turn running", 20000);
		if (scenario === "abort") {
			app.feed("\x1b");
			await waitFor(() => app.since(m).includes("Generation interrupted."), "interrupted", 10000);
			await tick(500);
		} else if (scenario === "rebuild") {
			m = await app.submit("STEER_KEPT please");
			await waitFor(() => app.since(m).includes(STEERING), "steer line", 10000);
			m = app.mark();
			app.feed("\x1bm"); // Alt+M: another model, so the tab's engine is rebuilt mid-turn
			await tick(9000);
		}
	}
	m = await app.submit("second question IDLE_MSG");
	await tick(5000);
	const screen = frameOf(app);
	app.emit({ phase: "idle-msg", steeringLines: screen.split(STEERING).length - 1, screen });
	await finish(0);
}

main().catch((e) => {
	process.stdout.write(
		`\n${JSON.stringify({ phase: "error", message: String(e?.message ?? e) })}\n`,
	);
	return finish(1);
});
