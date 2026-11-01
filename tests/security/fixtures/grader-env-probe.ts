/**
 * Probe harness for tests/security/grader-env.test.ts.
 *
 * The grader runs `bun test <this file>` exactly as it runs a real benchmark
 * harness. It loads the "model-written" code the grader wrote to disk, the same
 * way a benchmark does: single-file via FIXTURE_PATH, multi-file from WORK_DIR.
 * That code reports its own environment to a file the parent test reads.
 *
 * Deliberately not named *.test.ts, so `bun test tests/security` does not pick
 * it up on its own. The grader passes its absolute path, which bun runs.
 */
import { test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

test("load model-written code", async () => {
	const single = process.env.FIXTURE_PATH;
	const multi = process.env.WORK_DIR ? join(process.env.WORK_DIR, "probe.ts") : "";
	const target = single && existsSync(single) ? single : multi;
	await import(target);
});
