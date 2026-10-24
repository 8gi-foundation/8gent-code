import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CheckDef,
	DEFAULT_MIN_CALL_TOKENS,
	type LedgerLine,
	minimaxComplete,
	readLedger,
	runSelfImprove,
	selfImproveCommand,
	spentToday,
	validatePatch,
} from "./selfimprove";

const roots: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "selfimprove-"));
	roots.push(d);
	return d;
};
afterAll(() => {
	for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const NOON = new Date("2026-10-24T12:00:00.000Z");

/** A tiny genome: one source file, one marker file, two named checks run by sh. */
function cell() {
	const workspace = tmp();
	mkdirSync(join(workspace, "packages", "demo"), { recursive: true });
	writeFileSync(join(workspace, "packages", "demo", "thing.ts"), "export const v = 1;\n");
	writeFileSync(join(workspace, "packages", "demo", "keep.txt"), "keep\n");
	const cellDir = join(tmp(), "cell");
	const checks: CheckDef[] = [
		{ name: "v-is-two", cmd: ["sh", "-c", "grep -q 'v = 2' packages/demo/thing.ts"] },
		{ name: "keep-file", cmd: ["sh", "-c", "test -f packages/demo/keep.txt"] },
	];
	return { workspace, cellDir, checks };
}

const FIX = `diff --git a/packages/demo/thing.ts b/packages/demo/thing.ts
--- a/packages/demo/thing.ts
+++ b/packages/demo/thing.ts
@@ -1 +1 @@
-export const v = 1;
+export const v = 2;
`;
const FIX_AND_BREAK = `${FIX}diff --git a/packages/demo/keep.txt b/packages/demo/keep.txt
deleted file mode 100644
--- a/packages/demo/keep.txt
+++ /dev/null
@@ -1 +0,0 @@
-keep
`;
const NO_GAIN = `diff --git a/packages/demo/thing.ts b/packages/demo/thing.ts
--- a/packages/demo/thing.ts
+++ b/packages/demo/thing.ts
@@ -1 +1,2 @@
 export const v = 1;
+// a comment
`;

const cellEnv = (extra: Record<string, string> = {}) => ({
	CELL_ID: "cell-8to",
	SELFIMPROVE_PROVIDER: "minimax",
	DAILY_TOKEN_CAP: "100000",
	HARD_CAP_CEILING: "500000",
	...extra,
});

function model(reply: string, tokens: number | null = 3000) {
	const calls: { prompt: string; maxTokens: number }[] = [];
	return {
		calls,
		complete: async (prompt: string, o: { maxTokens: number }) => {
			calls.push({ prompt, maxTokens: o.maxTokens });
			return { text: reply, tokens };
		},
	};
}

describe("a round: run the frozen suite, propose one change, keep it only if nothing regressed", () => {
	test("a fix that improves a named check and regresses none is kept, saved on the cell, and logged with its energy", async () => {
		const c = cell();
		const m = model(`Here is the change:\n\`\`\`diff\n${FIX}\`\`\``);
		const r = await runSelfImprove({ ...c, env: cellEnv(), now: () => NOON, complete: m.complete });
		expect(r.verdict).toBe("kept");
		expect(r.improved).toEqual(["v-is-two"]);
		expect(r.regressed).toEqual([]);
		expect(r.tokens).toBe(3000);
		expect(m.calls.length).toBe(1);
		// The model was told which named checks fail, and nothing else about the person's world.
		expect(m.calls[0].prompt).toContain("v-is-two");
		expect(m.calls[0].prompt).not.toContain("keep-file");
		// Kept as a patch on the cell's own volume; the genome itself is untouched.
		const kept = readdirSync(join(c.cellDir, "kept")).filter((n) => n.endsWith(".patch"));
		expect(kept.length).toBe(1);
		expect(readFileSync(join(c.workspace, "packages", "demo", "thing.ts"), "utf-8")).toBe(
			"export const v = 1;\n",
		);
		const [line] = readLedger(c.cellDir);
		expect(line).toMatchObject({
			verdict: "kept",
			tokens: 3000,
			improved: ["v-is-two"],
			regressed: [],
			cell: "cell-8to",
		});
		expect(line.ts).toBe(NOON.toISOString());
	});

	test("a change that fixes one check but regresses another is reverted: nothing kept", async () => {
		const c = cell();
		const r = await runSelfImprove({
			...c,
			env: cellEnv(),
			now: () => NOON,
			complete: model(FIX_AND_BREAK).complete,
		});
		expect(r.verdict).toBe("reverted");
		expect(r.regressed).toEqual(["keep-file"]);
		expect(r.improved).toEqual(["v-is-two"]);
		expect(existsSync(join(c.cellDir, "kept"))).toBe(false);
		expect(readLedger(c.cellDir)[0]).toMatchObject({
			verdict: "reverted",
			regressed: ["keep-file"],
			tokens: 3000,
		});
	});

	test("a change that improves nothing is reverted, and its tokens are still spent", async () => {
		const c = cell();
		const r = await runSelfImprove({
			...c,
			env: cellEnv(),
			now: () => NOON,
			complete: model(NO_GAIN, 1200).complete,
		});
		expect(r.verdict).toBe("reverted");
		expect(r.improved).toEqual([]);
		expect(spentToday(readLedger(c.cellDir), NOON)).toBe(1200);
	});

	test("nothing failing at baseline: no model call, no tokens, an idle line", async () => {
		const c = cell();
		writeFileSync(join(c.workspace, "packages", "demo", "thing.ts"), "export const v = 2;\n");
		const m = model(FIX);
		const r = await runSelfImprove({ ...c, env: cellEnv(), now: () => NOON, complete: m.complete });
		expect(r.verdict).toBe("idle");
		expect(m.calls).toEqual([]);
		expect(readLedger(c.cellDir)[0]).toMatchObject({ verdict: "idle", tokens: 0 });
	});

	test("an answer with no diff, or a diff that does not apply, changes nothing and is logged with its tokens", async () => {
		for (const reply of [
			"I think you should change v to 2.",
			FIX.replace("-export const v = 1;", "-export const v = 9;"),
		]) {
			const c = cell();
			const r = await runSelfImprove({
				...c,
				env: cellEnv(),
				now: () => NOON,
				complete: model(reply, 800).complete,
			});
			expect(["reverted", "refused"]).toContain(r.verdict);
			expect(existsSync(join(c.cellDir, "kept"))).toBe(false);
			expect(spentToday(readLedger(c.cellDir), NOON)).toBe(800);
		}
	});

	test("kept patches are applied first in the next round, so a cell keeps what it learned", async () => {
		const c = cell();
		await runSelfImprove({ ...c, env: cellEnv(), now: () => NOON, complete: model(FIX).complete });
		const m = model(FIX);
		const r = await runSelfImprove({ ...c, env: cellEnv(), now: () => NOON, complete: m.complete });
		expect(r.verdict).toBe("idle"); // v-is-two already passes on the cell
		expect(m.calls).toEqual([]);
	});

	test("the suite is frozen: a changed check list is refused", async () => {
		const c = cell();
		await runSelfImprove({ ...c, env: cellEnv(), now: () => NOON, complete: model(FIX).complete });
		const other = [...c.checks, { name: "extra", cmd: ["sh", "-c", "true"] }];
		const m = model(FIX);
		const r = await runSelfImprove({
			...c,
			checks: other,
			env: cellEnv(),
			now: () => NOON,
			complete: m.complete,
		});
		expect(r.verdict).toBe("refused");
		expect(r.message).toMatch(/frozen|changed/i);
		expect(m.calls).toEqual([]);
	});
});

describe("patches the cell will not apply", () => {
	const ok = FIX;
	test("a plain source change is accepted", () => {
		expect(validatePatch(ok)).toEqual({ ok: true, files: ["packages/demo/thing.ts"], changed: 2 });
	});

	test("tests, the check list, permissions, the judge, this loop, secrets, paths that leave the tree, binaries, modes and symlinks are refused", () => {
		const mk = (path: string, extra = "") =>
			`diff --git a/${path} b/${path}\n${extra}--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
		for (const p of [
			"packages/decide/rules.test.ts",
			"packages/self-autonomy/cell-checks.json",
			"packages/permissions/policy-engine.ts",
			"packages/decide/guard.ts",
			"packages/decide/rules.ts",
			"packages/self-autonomy/selfimprove.ts",
			"packages/foo/.env",
			"packages/foo/secrets.ts",
			"bin/8gent.ts",
			"../etc/passwd",
			"/etc/passwd",
			"packages/../../x",
			"packages/foo/node_modules/x.js",
			".git/config",
		])
			expect(validatePatch(mk(p)).ok).toBe(false);
		expect(validatePatch(mk("packages/a.ts", "new mode 100755\n")).ok).toBe(false);
		expect(validatePatch(mk("packages/a.ts", "new file mode 120000\n")).ok).toBe(false);
		expect(
			validatePatch(mk("packages/a.ts", "rename from packages/b.ts\nrename to packages/a.ts\n")).ok,
		).toBe(false);
		expect(
			validatePatch(`diff --git a/packages/a.bin b/packages/a.bin\nGIT binary patch\nliteral 1\n`)
				.ok,
		).toBe(false);
		expect(validatePatch("").ok).toBe(false);
	});

	test("too big a change is refused: more than 5 files or 200 changed lines", () => {
		const file = (i: number) =>
			`diff --git a/packages/f${i}.ts b/packages/f${i}.ts\n--- a/packages/f${i}.ts\n+++ b/packages/f${i}.ts\n@@ -1 +1 @@\n-a\n+b\n`;
		expect(validatePatch(Array.from({ length: 6 }, (_, i) => file(i)).join("")).ok).toBe(false);
		const big = `diff --git a/packages/x.ts b/packages/x.ts\n--- a/packages/x.ts\n+++ b/packages/x.ts\n@@ -1 +1,201 @@\n-a\n${"+b\n".repeat(201)}`;
		expect(validatePatch(big).ok).toBe(false);
	});

	test("a refused patch is never applied and the suite is not rerun", async () => {
		const c = cell();
		const evil = `diff --git a/packages/decide/rules.test.ts b/packages/decide/rules.test.ts\n--- a/packages/decide/rules.test.ts\n+++ b/packages/decide/rules.test.ts\n@@ -1 +1 @@\n-a\n+b\n`;
		let reruns = 0;
		const r = await runSelfImprove({
			...c,
			env: cellEnv(),
			now: () => NOON,
			complete: model(evil, 500).complete,
			runCheck: async (def) => {
				reruns++;
				return { pass: def.name === "keep-file", tail: "" };
			},
		});
		expect(r.verdict).toBe("refused");
		expect(reruns).toBe(2); // the baseline only
		expect(spentToday(readLedger(c.cellDir), NOON)).toBe(500);
	});
});

describe("energy: the daily token cap is a hard limit inside the process", () => {
	const line = (ts: string, tokens: number): LedgerLine => ({
		ts,
		tokens,
		verdict: "kept",
		improved: [],
		regressed: [],
		cell: "c",
		round: 1,
	});

	test("spend is counted per UTC day: yesterday's lines and the next day's start do not count", () => {
		const lines = [
			line("2026-10-23T23:59:59.999Z", 5000),
			line("2026-10-24T00:00:00.000Z", 700),
			line("2026-10-24T11:00:00.000Z", 300),
		];
		expect(spentToday(lines, new Date("2026-10-24T12:00:00Z"))).toBe(1000);
		expect(spentToday(lines, new Date("2026-10-24T23:59:59.999Z"))).toBe(1000);
		expect(spentToday(lines, new Date("2026-10-25T00:00:00.000Z"))).toBe(0);
		expect(spentToday(lines, new Date("2026-10-23T23:59:59.999Z"))).toBe(5000);
	});

	test("a spent cell is dormant: no API call, one dormant line, until 00:00 UTC", async () => {
		const c = cell();
		mkdirSync(c.cellDir, { recursive: true });
		writeFileSync(
			join(c.cellDir, "energy.jsonl"),
			`${JSON.stringify(line("2026-10-24T08:00:00.000Z", 100000))}\n`,
		);
		const m = model(FIX);
		let ran = 0;
		const r = await runSelfImprove({
			...c,
			env: cellEnv(),
			now: () => NOON,
			complete: m.complete,
			runCheck: async () => {
				ran++;
				return { pass: true, tail: "" };
			},
		});
		expect(r.verdict).toBe("dormant");
		expect(m.calls).toEqual([]);
		expect(ran).toBe(0); // a spent cell does no work at all
		// A second run the same day does not log another dormant line.
		await runSelfImprove({
			...c,
			env: cellEnv(),
			now: () => new Date("2026-10-24T20:00:00Z"),
			complete: m.complete,
		});
		expect(readLedger(c.cellDir).filter((l) => l.verdict === "dormant").length).toBe(1);
		// At 00:00 UTC it wakes.
		const next = await runSelfImprove({
			...c,
			env: cellEnv(),
			now: () => new Date("2026-10-25T00:00:00Z"),
			complete: model(FIX).complete,
		});
		expect(next.verdict).toBe("kept");
	});

	test("the call is capped by what is left: max_tokens plus the prompt can never pass the cap", async () => {
		const c = cell();
		mkdirSync(c.cellDir, { recursive: true });
		writeFileSync(
			join(c.cellDir, "energy.jsonl"),
			`${JSON.stringify(line("2026-10-24T08:00:00.000Z", 96000))}\n`,
		);
		const m = model(FIX, 2500);
		const r = await runSelfImprove({ ...c, env: cellEnv(), now: () => NOON, complete: m.complete });
		expect(r.verdict).toBe("kept");
		expect(m.calls[0].maxTokens).toBeLessThanOrEqual(
			4000 - Math.ceil(m.calls[0].prompt.length / 3),
		);
		expect(m.calls[0].maxTokens).toBeGreaterThan(0);
	});

	test("not enough left for a worthwhile call: dormant, no call", async () => {
		const c = cell();
		mkdirSync(c.cellDir, { recursive: true });
		writeFileSync(
			join(c.cellDir, "energy.jsonl"),
			`${JSON.stringify(line("2026-10-24T08:00:00.000Z", 100000 - (DEFAULT_MIN_CALL_TOKENS - 1)))}\n`,
		);
		const m = model(FIX);
		expect(
			(await runSelfImprove({ ...c, env: cellEnv(), now: () => NOON, complete: m.complete }))
				.verdict,
		).toBe("dormant");
		expect(m.calls).toEqual([]);
	});

	test("tokens come from the API's usage; with none reported they are estimated, never zero", async () => {
		const c = cell();
		const r = await runSelfImprove({
			...c,
			env: cellEnv(),
			now: () => NOON,
			complete: model(FIX, null).complete,
		});
		expect(r.tokens).toBeGreaterThan(0);
		expect(spentToday(readLedger(c.cellDir), NOON)).toBe(r.tokens);
	});

	test("no cap, a zero cap, or a cap above the ceiling means no round", async () => {
		for (const env of [
			{ DAILY_TOKEN_CAP: "" },
			{ DAILY_TOKEN_CAP: "0" },
			{ DAILY_TOKEN_CAP: "abc" },
			{ DAILY_TOKEN_CAP: "900000" },
		]) {
			const c = cell();
			const m = model(FIX);
			const r = await runSelfImprove({
				...c,
				env: cellEnv(env),
				now: () => NOON,
				complete: m.complete,
			});
			expect(r.verdict).toBe("refused");
			expect(m.calls).toEqual([]);
		}
	});

	test("a call that spends the whole budget ends the day: the next round the same day is dormant", async () => {
		const c = cell();
		await runSelfImprove({
			...c,
			env: cellEnv({ DAILY_TOKEN_CAP: "4000" }),
			now: () => NOON,
			complete: model(NO_GAIN, 3900).complete,
		});
		const m = model(FIX);
		const r = await runSelfImprove({
			...c,
			env: cellEnv({ DAILY_TOKEN_CAP: "4000" }),
			now: () => NOON,
			complete: m.complete,
		});
		expect(r.verdict).toBe("dormant");
		expect(m.calls).toEqual([]);
	});
});

describe("only a cell, only the MiniMax API, by our own choice", () => {
	test("outside a cell (no CELL_ID) nothing runs and nothing is sent", async () => {
		const c = cell();
		const m = model(FIX);
		const { CELL_ID: _x, ...env } = cellEnv();
		const r = await runSelfImprove({ ...c, env, now: () => NOON, complete: m.complete });
		expect(r.verdict).toBe("refused");
		expect(r.message).toMatch(/cell/i);
		expect(m.calls).toEqual([]);
		expect(existsSync(c.cellDir)).toBe(false);
	});

	test("another provider than minimax is refused", async () => {
		const c = cell();
		const m = model(FIX);
		const r = await runSelfImprove({
			...c,
			env: cellEnv({ SELFIMPROVE_PROVIDER: "openai" }),
			now: () => NOON,
			complete: m.complete,
		});
		expect(r.verdict).toBe("refused");
		expect(m.calls).toEqual([]);
	});

	test("the command: exit 0 on a round, 1 on a refusal", async () => {
		const c = cell();
		const out: string[] = [];
		const ok = await selfImproveCommand([], {
			...c,
			env: cellEnv(),
			now: () => NOON,
			complete: model(FIX).complete,
			say: (l) => out.push(l),
		});
		expect(ok).toBe(0);
		expect(out.join("\n")).toContain("kept");
		const { CELL_ID: _x, ...env } = cellEnv();
		expect(
			await selfImproveCommand([], {
				...cell(),
				env,
				now: () => NOON,
				complete: model(FIX).complete,
				say: () => {},
			}),
		).toBe(1);
	});
});

describe("the MiniMax call", () => {
	test("OpenAI-compatible chat completions at the registry's base URL, with the key, a token cap, and no redirects", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const out = await minimaxComplete(
			"fix it",
			{ maxTokens: 900 },
			{
				baseUrl: "https://api.minimax.io/v1",
				key: "k-secret",
				model: "m-1",
				fetchImpl: async (url, init) => {
					seen.push({ url: String(url), init: init as RequestInit });
					return Response.json({
						choices: [{ message: { content: "diff text" } }],
						usage: { total_tokens: 777 },
					});
				},
			},
		);
		expect(out).toEqual({ text: "diff text", tokens: 777 });
		expect(seen[0].url).toBe("https://api.minimax.io/v1/chat/completions");
		const h = seen[0].init.headers as Record<string, string>;
		expect(h.authorization).toBe("Bearer k-secret");
		expect(seen[0].init.redirect).toBe("error");
		const body = JSON.parse(String(seen[0].init.body));
		expect(body).toMatchObject({ model: "m-1", max_tokens: 900 });
		expect(JSON.stringify(body)).not.toContain("k-secret");
	});

	test("a non-2xx or an answer with no text is an error, and the key is not in the message", async () => {
		const bad = (r: () => Response) =>
			minimaxComplete(
				"x",
				{ maxTokens: 10 },
				{
					baseUrl: "https://api.minimax.io/v1",
					key: "k-secret",
					model: "m",
					fetchImpl: async () => r(),
				},
			);
		await expect(bad(() => new Response("no", { status: 401 }))).rejects.toThrow(/401/);
		await expect(bad(() => Response.json({ choices: [] }))).rejects.toThrow();
		await bad(() => new Response("nope k-secret", { status: 500 })).catch((e: Error) =>
			expect(e.message).not.toContain("k-secret"),
		);
	});

	test("a plain-http base URL is refused: the key never travels in the clear", async () => {
		await expect(
			minimaxComplete(
				"x",
				{ maxTokens: 10 },
				{
					baseUrl: "http://api.example/v1",
					key: "k",
					model: "m",
					fetchImpl: async () => Response.json({}),
				},
			),
		).rejects.toThrow(/https/);
	});
});

describe("the image carries the CLI (#4937)", () => {
	const docker = readFileSync(join(import.meta.dir, "..", "..", "Dockerfile"), "utf-8");
	test("the vessel Dockerfile copies bin/ and the frozen checks, and has git for applying patches", () => {
		expect(docker).toMatch(/COPY bin\/ bin\//);
		expect(docker).toMatch(/apt-get install[^\n]*\bgit\b/);
		expect(docker).toMatch(/COPY tests\/ tests\//);
	});
});

describe("checks run without the model's key", () => {
	test("a check that sees MINIMAX_API_KEY in its environment fails: it is not passed down", async () => {
		const c = cell();
		const prev = process.env.MINIMAX_API_KEY;
		process.env.MINIMAX_API_KEY = "k-secret-in-parent";
		try {
			const checks: CheckDef[] = [
				{ name: "no-key", cmd: ["sh", "-c", 'test -z "$MINIMAX_API_KEY"'] },
			];
			const r = await runSelfImprove({
				...c,
				checks,
				env: cellEnv(),
				now: () => NOON,
				complete: model(FIX).complete,
			});
			expect(r.verdict).toBe("idle"); // the check passed at baseline: the key was not there
		} finally {
			process.env.MINIMAX_API_KEY = prev ?? "";
		}
	});
});

describe("the shipped suite", () => {
	test("every check passes on a clean copy of this tree, so a healthy cell has nothing to fix and spends nothing", async () => {
		const cellDir = join(tmp(), "cell");
		const m = model(FIX);
		const r = await runSelfImprove({
			cellDir,
			env: cellEnv(),
			now: () => NOON,
			complete: m.complete,
		});
		expect(r.message).toBe("every named check passes; nothing to improve");
		expect(r.verdict).toBe("idle");
		expect(m.calls).toEqual([]);
	}, 120_000);
});
