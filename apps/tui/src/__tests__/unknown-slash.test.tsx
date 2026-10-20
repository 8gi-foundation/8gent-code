/** An unknown slash line never reaches the model; known commands and plain text still do (#4530). */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
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
			HOME: fs.mkdtempSync(path.join(os.tmpdir(), "unknown-slash-home-")),
		});
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		expect(events.find((e) => e.phase === "unknown")?.ok).toBeTrue();
		expect(events.find((e) => e.phase === "known")?.ok).toBeTrue();
		expect(events.find((e) => e.phase === "plain")?.ok).toBeTrue();
		expect(events.find((e) => e.phase === "template")?.ok).toBeTrue();
		expect(events.find((e) => e.phase === "skill")?.ok).toBeTrue();

		const bodies = JSON.stringify(model.requests);
		expect(bodies).not.toContain("nope-xyz-unknown");
		expect(bodies).toContain("plain text turn");
		expect(bodies).toContain("LATE-TEMPLATE-BODY-4536 alpha");
		expect(bodies).toContain("LATE-SKILL-BODY-4536");
	} finally {
		model.stop();
	}
}, 90_000);
