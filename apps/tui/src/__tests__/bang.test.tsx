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

test("!cmd reaches the model once; !!, stopped and Plan-mode lines never do; nothing is saved", async () => {
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
		expect(turn).toContain("Command: echo from-the-shell-abc (exit 0)");
		expect(turn).toContain("not words the user wrote");
		expect(turn).toContain("from-the-shell-abc\n```");
		// The next message goes alone: the block was sent once.
		const next = texts.filter((t) => t.endsWith("and now"));
		expect(next.length).toBeGreaterThan(0);
		for (const t of next) expect(t).not.toContain("from-the-shell-abc");
		// `!!` output never reaches the model.
		for (const t of texts) expect(t).not.toContain("kept-local-xyz");
		// A credentials-file command shows its output and never sends it.
		expect(events.find((e) => e.phase === "cred")?.shown).toBeTrue();
		for (const t of texts) expect(t).not.toContain("credfile-zz9");
		// A stopped command never reaches the model either.
		for (const t of texts) expect(t).not.toContain("setTimeout(() => {}, 20000)");

		// Esc stopped the slow command quickly; Plan mode ran nothing.
		expect(Number(events.find((e) => e.phase === "cancel")?.ms)).toBeLessThan(5000);
		expect(events.find((e) => e.phase === "plan")?.ran).toBeFalse();
		for (const t of texts) expect(t).not.toContain("should-not-run-123");

		// The session was saved, and no file under HOME holds the `!!` output.
		const saved = events.find((e) => e.phase === "saved") as { leaks: string[]; sessions: number };
		expect(saved.sessions).toBeGreaterThan(0);
		expect(saved.leaks).toEqual([]);
	} finally {
		model.stop();
	}
}, 120000);
