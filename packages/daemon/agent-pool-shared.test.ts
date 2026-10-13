/**
 * #3929: the pool never evicts a session a client is attached to, says when
 * there is no room, and tells listeners when a cap eviction ends a session.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/temp-dirs";

let dir: string;
const savedData = process.env.EIGHT_DATA_DIR;
let AgentPool: typeof import("./agent-pool").AgentPool;
let bus: typeof import("./events").bus;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pool3929-"));
	process.env.EIGHT_DATA_DIR = dir;
	({ AgentPool } = await import("./agent-pool"));
	({ bus } = await import("./events"));
});

afterAll(() => {
	if (savedData === undefined) delete process.env.EIGHT_DATA_DIR;
	else process.env.EIGHT_DATA_DIR = savedData;
	// Windows keeps the pool's open files locked until the process ends; removeDir leaves that to the run-end sweep.
	removeDir(dir);
});

describe("pool room and attached sessions (#3929)", () => {
	test("an attached session is never evicted, and a full pool of them has no room", () => {
		// The computer channel caps at 3, so three sessions fill it.
		const pool = new AgentPool({ runtime: "ollama", model: "fake", workingDirectory: dir });
		const attached = new Set<string>();
		pool.setInUse((id) => attached.has(id));
		for (const id of ["c1", "c2", "c3"]) pool.createSession(id, "computer");
		expect(pool.canCreate("computer")).toBe(true);

		attached.add("c1");
		attached.add("c2");
		attached.add("c3");
		expect(pool.canCreate("computer")).toBe(false);

		attached.delete("c2");
		expect(pool.canCreate("computer")).toBe(true);
		const ended: Array<{ sessionId: string; reason: string }> = [];
		const off = bus.on("session:end", (p) => ended.push(p));
		pool.createSession("c4", "computer");
		bus.off(off);
		expect(pool.hasSession("c1")).toBe(true);
		expect(pool.hasSession("c3")).toBe(true);
		expect(pool.hasSession("c2")).toBe(false);
		expect(ended).toEqual([{ sessionId: "c2", reason: "channel-cap-evict" }]);
		for (const id of ["c1", "c3", "c4"]) pool.destroySession(id);
	});
});
