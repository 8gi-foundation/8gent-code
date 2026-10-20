/** An unknown slash line never reaches the model; known commands and plain text still do (#4530). */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { serveFakeModel } from "./fake-model.js";

const REPLY = "Plain turn answered.";

test("unknown slash is answered locally and never sent; /help and plain text behave as before", async () => {
	const model = serveFakeModel(REPLY);
	try {
		const events = await runAppHarness(path.join(import.meta.dir, "unknown-slash.harness.tsx"), {
			...model.env,
			FAKE_REPLY: REPLY,
		});
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		expect(events.find((e) => e.phase === "unknown")?.ok).toBeTrue();
		expect(events.find((e) => e.phase === "known")?.ok).toBeTrue();
		expect(events.find((e) => e.phase === "plain")?.ok).toBeTrue();

		const bodies = JSON.stringify(model.requests);
		expect(bodies).not.toContain("nope-xyz-unknown");
		expect(bodies).toContain("plain text turn");
	} finally {
		model.stop();
	}
}, 90_000);
