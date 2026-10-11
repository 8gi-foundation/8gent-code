/** `!cmd` output reaches the model with the next message; `!!cmd` stays local (#3918 D5). */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { serveFakeModel } from "./fake-model.js";

const REPLY = "Noted the shell output.";

/** Every user message text in every chat request body. */
function userTexts(requests: unknown[]): string[] {
	return requests.flatMap((body) =>
		((body as { messages?: { role: string; content: unknown }[] }).messages ?? [])
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
	);
}

test("!cmd goes to the model once with the next message; !!cmd never does", async () => {
	const model = serveFakeModel(REPLY);
	try {
		const events = await runAppHarness(path.join(import.meta.dir, "bang.harness.tsx"), {
			...model.env,
			FAKE_REPLY: REPLY,
		});
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		expect(events.find((e) => e.phase === "local")?.ok).toBeTrue();
		expect(events.find((e) => e.phase === "send")?.ok).toBeTrue();

		// The task router first asks the model to classify the message alone;
		// that request is not the turn.
		const texts = userTexts(model.requests).filter((t) => !t.startsWith("Classify this user task"));
		// The turn's own message: the shell block in front of what was typed.
		const turn = texts.find((t) => t.endsWith("what did it print"));
		expect(turn).toBeDefined();
		expect(turn).toContain("I ran `echo from-the-shell-abc` in the shell (exit 0).");
		expect(turn).toContain("from-the-shell-abc\n```");
		// The next message goes alone: the block was sent once.
		const next = texts.filter((t) => t.endsWith("and now"));
		expect(next.length).toBeGreaterThan(0);
		for (const t of next) expect(t).not.toContain("from-the-shell-abc");
		// `!!` output never reaches the model.
		for (const t of texts) expect(t).not.toContain("kept-local-xyz");
	} finally {
		model.stop();
	}
}, 120000);
