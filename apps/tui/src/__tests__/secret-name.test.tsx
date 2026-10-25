/** A key is never a name: startup scrub and /rename in the real App (#5098). */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { serveFakeModel } from "./fake-model.js";

const KEY = "sk-ant-api03-AbCdEf1234567890AbCdEf1234567890";

test("saved key-names are reset with one notice; /rename refuses a key and keeps real names", async () => {
	const model = serveFakeModel("ok");
	try {
		const events = await runAppHarness(path.join(import.meta.dir, "secret-name.harness.tsx"), {
			...model.env,
			SECRET_KEY: KEY,
		});
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		for (const phase of ["scrub", "disk", "rename-refused", "rename-ok"]) {
			expect(events.find((e) => e.phase === phase)?.ok).toBeTrue();
		}
		expect(JSON.stringify(model.requests)).not.toContain(KEY);
	} finally {
		model.stop();
	}
}, 90_000);
