/** /copy puts the last answer on the clipboard via OSC 52, in the real App (#3918 D7). */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { osc52 } from "../lib/mouse-wiring.js";
import { runAppHarness } from "./app-driver.js";
import { serveFakeModel } from "./fake-model.js";

const REPLY = "Copy me: ünïcode and all";

test("/copy writes the last answer as OSC 52 and says so", async () => {
	const model = serveFakeModel(REPLY);
	try {
		const events = await runAppHarness(path.join(import.meta.dir, "copy.harness.tsx"), {
			...model.env,
			FAKE_REPLY: REPLY,
			// Local copy commands stay out of the test; OSC 52 is the path under test.
			SSH_CONNECTION: "test",
			TMUX: "",
			STY: "",
		});
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		expect(events.find((e) => e.phase === "empty")?.ok).toBeTrue();
		const copied = events.find((e) => e.phase === "copied");
		expect(copied?.line).toBe(
			`Sent the last answer to the clipboard (${REPLY.length} characters).`,
		);
		expect(String(copied?.raw)).toContain(osc52(REPLY));
	} finally {
		model.stop();
	}
}, 90000);
