/** `/skill:name` in the real App runs a skill found in <project>/.agents/skills (pi-skills, G3). */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { serveFakeModel } from "./fake-model.js";

const REPLY = "pong";

test("/skill:demo sends the skill prompt to the model; /skill:nope gets a clear message", async () => {
	const model = serveFakeModel(REPLY);
	try {
		const env: Record<string, string> = { ...model.env, FAKE_REPLY: REPLY };
		if (process.env.CAST_OUT) env.CAST_OUT = process.env.CAST_OUT;
		const events = await runAppHarness(path.join(import.meta.dir, "skill-slash.harness.tsx"), env);
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		expect(events.find((e) => e.phase === "demo")?.ok).toBeTrue();
		expect(events.find((e) => e.phase === "unknown")?.ok).toBeTrue();
		const bodies = JSON.stringify(model.requests);
		expect(bodies).toContain("[SKILL: demo]");
		expect(bodies).toContain("DEMO-SKILL-BODY-7731");
		expect(bodies).toContain('Unknown skill');
		expect(bodies).toContain("Available skills:");
	} finally {
		model.stop();
	}
}, 120000);
