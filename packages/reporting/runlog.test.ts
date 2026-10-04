import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import {
	CLAIMS_MAX,
	CLAIM_MAX_CHARS,
	FACTS_MAX,
	FACT_MAX_CHARS,
	PROMPT_MAX_CHARS,
	QUICK_TEXT_MAX_CHARS,
	type RunLogEntry,
	capRunEntry,
} from "./runlog";

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
afterAll(cleanupTempDirs);

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
		const home = tempDir("runlog-cap-");
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

describe("run log quick facts and text caps (#3416)", () => {
	test("capRunEntry keeps at most 8 facts of at most 40 chars, and 300 chars of text", () => {
		const entry = {
			...base,
			quick: {
				class: "quick",
				ran: true,
				ok: true,
				ms: 1,
				tools: 1,
				facts: Array.from({ length: 12 }, (_, i) => `${i}${"f".repeat(100)}`),
				text: "t".repeat(1000),
			},
		};
		const out = capRunEntry(entry);
		expect(FACTS_MAX).toBe(8);
		expect(FACT_MAX_CHARS).toBe(40);
		expect(QUICK_TEXT_MAX_CHARS).toBe(300);
		expect(out.quick?.facts).toHaveLength(8);
		for (const f of out.quick?.facts ?? []) expect(f.length).toBeLessThanOrEqual(40);
		expect(out.quick?.facts?.[0].startsWith("0")).toBe(true);
		expect(out.quick?.text).toHaveLength(300);
		expect(entry.quick.facts).toHaveLength(12);
	});
});

describe("run log redaction at the write (#3416)", () => {
	const key = `sk-proj-${"Hq3_Lm7-Vt9".repeat(3)}`;

	test("prompt, claims and text are redacted; a fact the redactor changes is dropped", () => {
		const out = capRunEntry({
			...base,
			prompt: `use ${key} please`,
			quick: {
				class: "quick",
				ran: true,
				ok: false,
				ms: 1,
				tools: 1,
				claims: [`ran with ${key}`],
				facts: ["5180", key, "Bearer abcdefghijklmnop1234"],
				text: `port 5180, key ${key}`,
			},
		});
		const all = JSON.stringify(out);
		expect(all).not.toContain("Hq3_Lm7");
		expect(all).not.toContain("abcdefghijklmnop1234");
		expect(out.prompt).toBe("use [REDACTED_OPENAI_KEY] please");
		expect(out.quick?.facts).toEqual(["5180"]);
		expect(out.quick?.text).toBe("port 5180, key [REDACTED_OPENAI_KEY]");
		expect(out.quick?.claims).toEqual(["ran with [REDACTED_OPENAI_KEY]"]);
	});

	test("an entry with nothing to redact or cap is returned as is", () => {
		const entry = { ...base, prompt: "which port does staging use?" };
		expect(capRunEntry(entry)).toBe(entry);
	});
});

describe("run log prompt: redacted before it is cut (#3416)", () => {
	const SECRETS: Array<[string, string]> = [
		["postgres URL credentials", "postgres://ops:Wy5Qz8Kp3Jv7@db.internal:5432/app"],
		["sk-proj key", `sk-proj-${"Hq3Lm7Vt9".repeat(4)}`],
	];
	const secretPart = (s: string) =>
		s.startsWith("postgres") ? "Wy5Qz8Kp3Jv7" : s.slice("sk-proj-".length);

	test("PROMPT_MAX_CHARS is 120", () => {
		expect(PROMPT_MAX_CHARS).toBe(120);
	});

	for (const [name, secret] of SECRETS) {
		test(`a ${name} slid across the 120-char boundary leaves no fragment at any offset`, () => {
			const part = secretPart(secret);
			const fragments = new Set<string>();
			for (let i = 0; i + 4 <= part.length; i++) fragments.add(part.slice(i, i + 4));
			for (let offset = 0; offset <= PROMPT_MAX_CHARS + 5; offset++) {
				const prompt = `${"x ".repeat(80).slice(0, offset)}${secret} and more words after it`;
				const out = capRunEntry({ ...base, prompt });
				expect(out.prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
				for (const f of fragments) expect(out.prompt).not.toContain(f);
			}
		});
	}

	test("a claim cut only after redaction keeps no fragment either", () => {
		const secret = `sk-proj-${"Hq3Lm7Vt9".repeat(4)}`;
		for (let offset = 90; offset <= CLAIM_MAX_CHARS + 2; offset++) {
			const claim = `${"y".repeat(offset)}${secret}`;
			const out = capRunEntry({
				...base,
				quick: { class: "quick", ran: true, ok: false, ms: 1, tools: 1, claims: [claim] },
			});
			expect(out.quick?.claims?.[0]).not.toContain("Hq3L");
			expect(out.quick?.claims?.[0]).not.toContain("Vt9");
		}
	});

	test("a short prompt with nothing to redact is still returned as is", () => {
		const entry = { ...base, prompt: "which port does staging use?" };
		expect(capRunEntry(entry)).toBe(entry);
	});
});
