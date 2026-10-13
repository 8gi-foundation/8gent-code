import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIMS_MAX, CLAIM_MAX_CHARS, type RunLogEntry, capRunEntry } from "./runlog";

const base: RunLogEntry = {
	ts: "2026-10-03T00:00:00.000Z",
	status: "ok",
	model: "m",
	dur: 1,
	tokens: 0,
	cost: null,
	tools: 0,
	created: [],
	modified: [],
	session: "s",
	cwd: "/w",
	prompt: "p",
};
const long = (i: number) => `${i}:${"x".repeat(500)}`;

describe("run log claims cap (#3411, 8SO L3)", () => {
	test("capRunEntry keeps at most 5 claims of at most 120 chars", () => {
		const entry = {
			...base,
			quick: {
				class: "quick",
				ran: true,
				ok: false,
				ms: 1,
				tools: 1,
				claims: [0, 1, 2, 3, 4, 5, 6].map(long),
			},
		};
		const out = capRunEntry(entry);
		expect(out.quick?.claims).toHaveLength(CLAIMS_MAX);
		for (const c of out.quick?.claims ?? []) expect(c.length).toBeLessThanOrEqual(CLAIM_MAX_CHARS);
		expect(out.quick?.claims?.[0].startsWith("0:")).toBe(true);
		expect(entry.quick.claims).toHaveLength(7);
	});

	test("an entry without claims passes through unchanged", () => {
		expect(capRunEntry(base)).toBe(base);
	});

	test("appendRun writes the capped claims to runs.jsonl", () => {
		const home = mkdtempSync(join(tmpdir(), "runlog-cap-"));
		const script = `const { appendRun } = await import(${JSON.stringify(join(import.meta.dir, "runlog.ts"))});
appendRun(${JSON.stringify({ ...base, quick: { class: "quick", ran: true, ok: false, ms: 1, tools: 1, claims: [0, 1, 2, 3, 4, 5, 6].map(long) } })});`;
		const r = Bun.spawnSync([process.execPath, "-e", script], {
			env: { ...process.env, HOME: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(r.exitCode).toBe(0);
		const line = JSON.parse(readFileSync(join(home, ".8gent", "runs.jsonl"), "utf8").trim());
		expect(line.quick.claims).toHaveLength(CLAIMS_MAX);
		for (const c of line.quick.claims) expect(c.length).toBeLessThanOrEqual(CLAIM_MAX_CHARS);
	});
});
