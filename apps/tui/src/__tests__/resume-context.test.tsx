/**
 * Resume in the real App: the reopened chat is on screen AND in the model's
 * next request, the picker names a session by its first prompt, and the
 * original times survive the resume.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { serveFakeModel } from "./fake-model.js";

const REPLY = "FAKE_DONE";

function sent(requests: unknown[]): string {
	return JSON.stringify(requests.at(-1) ?? "");
}

for (const mode of ["boot", "picker"] as const) {
	test(`resume (${mode}): the next request carries the earlier turns`, async () => {
		const model = serveFakeModel(REPLY);
		try {
			const events = await runAppHarness(
				path.join(import.meta.dir, "resume-context.harness.tsx"),
				{ ...model.env, MODE: mode },
				120_000,
			);
			expect(events.find((e) => e.phase === "error")).toBeUndefined();
			const body = sent(model.requests);
			expect(body).toContain("PINEAPPLE-42");
			expect(body).toContain("Committed as sha 1a2b3c4.");
			expect(body).toContain("What was the codeword and the sha?");
			expect(events.find((e) => e.phase === "done")).toBeDefined();
			if (mode === "picker") {
				const screen = String(events.find((e) => e.phase === "picker")?.screen);
				expect(screen).toContain("Add a clamp helper and");
				expect(screen).not.toContain("untitled resumeprobe1");
				// 2024-03-01 is hundreds of days back: shown in days, not minutes.
				expect(screen).toMatch(/4 msgs\s+\d{3,}d/);
			}
		} finally {
			model.stop();
		}
	}, 150_000);
}
