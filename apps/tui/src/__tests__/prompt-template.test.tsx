/**
 * Prompt templates as /name in the real App (#3918 G4). The frames are
 * written as an asciicast under $TMPDIR.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { type Frame, castPath, writeCast } from "./cast.js";
import { serveFakeModel } from "./fake-model.js";

const REPLY = "TEMPLATE_REPLY_OK";

function userTexts(requests: unknown[]): string[] {
	return requests.flatMap((body) =>
		((body as { messages?: { role: string; content: unknown }[] }).messages ?? [])
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
	);
}

test("a ~/.8gent/prompts template is listed as /name and sends its text filled in", async () => {
	const model = serveFakeModel(REPLY);
	try {
		const events = await runAppHarness(
			path.join(import.meta.dir, "prompt-template.harness.tsx"),
			{ ...model.env, FAKE_REPLY: REPLY },
			100_000,
		);
		const frames = (events.find((e) => e.phase === "frames")?.frames ?? []) as Frame[];
		const cast = castPath("pi-tui-g4-prompt-templates");
		writeCast(cast, frames, 160, 50, "8gent Code: prompt templates as /name");
		console.log(`[prompt-template.test] ${frames.length} frames -> ${cast}`);

		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		expect(String(events.find((e) => e.phase === "menu")?.screen)).toContain(
			"/review Review a file for bugs",
		);
		expect(events.find((e) => e.phase === "sent")?.ok).toBeTrue();
		// The model got the template's text, not the slash line. (The task
		// router's classification request is not the turn.)
		const texts = userTexts(model.requests).filter((t) => !t.startsWith("Classify this user task"));
		expect(
			texts.some((t) => t.includes("Review src/app.ts for correctness bugs. Mode: strict.")),
		).toBeTrue();
		expect(texts.some((t) => t.includes("/review src/app.ts"))).toBeFalse();
	} finally {
		model.stop();
	}
}, 130_000);
