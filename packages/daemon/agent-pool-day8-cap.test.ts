/**
 * #5203: a Day8 player never holds more than three sessions, and a full set of
 * attached day8 sessions refuses a fourth without touching an officer's own session.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/temp-dirs";

let dir: string;
const savedData = process.env.EIGHT_DATA_DIR;
let AgentPool: typeof import("./agent-pool").AgentPool;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pool5203-"));
	process.env.EIGHT_DATA_DIR = dir;
	({ AgentPool } = await import("./agent-pool"));
});

afterAll(() => {
	if (savedData === undefined) delete process.env.EIGHT_DATA_DIR;
	else process.env.EIGHT_DATA_DIR = savedData;
	removeDir(dir);
});

describe("day8 session cap (#5203)", () => {
	test("a fourth day8 session is refused while an officer's own session survives", () => {
		const pool = new AgentPool({ runtime: "ollama", model: "fake", workingDirectory: dir });
		const attached = new Set<string>();
		pool.setInUse((id) => attached.has(id));
		pool.createSession("officer", "telegram");
		for (const id of ["d1", "d2", "d3"]) {
			pool.createSession(id, "day8");
			attached.add(id);
		}
		expect(pool.canCreate("day8")).toBe(false);
		// Another channel is not held up by the full day8 set.
		expect(pool.canCreate("api")).toBe(true);
		expect(pool.hasSession("officer")).toBe(true);
		for (const id of ["d1", "d2", "d3"]) expect(pool.hasSession(id)).toBe(true);
		for (const id of ["officer", "d1", "d2", "d3"]) pool.destroySession(id);
	});

	test("an idle day8 session is evicted to make room, never the officer's", () => {
		const pool = new AgentPool({ runtime: "ollama", model: "fake", workingDirectory: dir });
		pool.createSession("officer", "telegram");
		for (const id of ["d1", "d2", "d3"]) pool.createSession(id, "day8");
		pool.createSession("d4", "day8");
		expect(pool.hasSession("d1")).toBe(false);
		expect(pool.hasSession("officer")).toBe(true);
		for (const id of ["officer", "d2", "d3", "d4"]) pool.destroySession(id);
	});

	test("day8 is reaped after 10 minutes idle", () => {
		const pool = new AgentPool({ runtime: "ollama", model: "fake", workingDirectory: dir });
		// biome-ignore lint/suspicious/noExplicitAny: reads the private idle timeout
		expect((pool as any).idleTimeoutFor("day8")).toBe(10 * 60 * 1000);
	});
});
