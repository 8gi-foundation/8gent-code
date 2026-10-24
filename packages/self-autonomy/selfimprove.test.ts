import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CallError,
	type CheckDef,
	DEFAULT_MIN_CALL_TOKENS,
	type LedgerLine,
	linuxSandbox,
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
	mkdirSync(join(workspace, "packages", "self-autonomy", "skills"), { recursive: true });
	writeFileSync(
		join(workspace, "packages", "self-autonomy", "skills", "thing.ts"),
		"export const v = 1;\n",
	);
	writeFileSync(join(workspace, "packages", "self-autonomy", "skills", "keep.txt"), "keep\n");
	const cellDir = join(tmp(), "cell");
	const checks: CheckDef[] = [
		{
			name: "v-is-two",
			cmd: ["sh", "-c", "grep -q 'v = 2' packages/self-autonomy/skills/thing.ts"],
		},
		{ name: "keep-file", cmd: ["sh", "-c", "test -f packages/self-autonomy/skills/keep.txt"] },
	];
	// Tests run the checks directly: the sandbox is proven on its own below and in the image.
	return { workspace, cellDir, checks, sandbox: "off" as const };
}

const FIX = `diff --git a/packages/self-autonomy/skills/thing.ts b/packages/self-autonomy/skills/thing.ts
--- a/packages/self-autonomy/skills/thing.ts
+++ b/packages/self-autonomy/skills/thing.ts
@@ -1 +1 @@
-export const v = 1;
+export const v = 2;
`;
const FIX_AND_BREAK = `${FIX}diff --git a/packages/self-autonomy/skills/keep.txt b/packages/self-autonomy/skills/keep.txt
deleted file mode 100644
--- a/packages/self-autonomy/skills/keep.txt
+++ /dev/null
@@ -1 +0,0 @@
-keep
`;
const NO_GAIN = `diff --git a/packages/self-autonomy/skills/thing.ts b/packages/self-autonomy/skills/thing.ts
--- a/packages/self-autonomy/skills/thing.ts
+++ b/packages/self-autonomy/skills/thing.ts
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
		expect(
			readFileSync(join(c.workspace, "packages", "self-autonomy", "skills", "thing.ts"), "utf-8"),
		).toBe("export const v = 1;\n");
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
		writeFileSync(
			join(c.workspace, "packages", "self-autonomy", "skills", "thing.ts"),
			"export const v = 2;\n",
		);
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

	test("a kept patch that is not valid any more is set aside, not replayed", async () => {
		const c = cell();
		mkdirSync(join(c.workspace, "packages", "other"), { recursive: true });
		writeFileSync(join(c.workspace, "packages", "other", "x.ts"), "a\n");
		const checks: CheckDef[] = [
			{ name: "x-untouched", cmd: ["sh", "-c", "grep -q a packages/other/x.ts"] },
		];
		mkdirSync(join(c.cellDir, "kept"), { recursive: true });
		// Structurally fine, applies cleanly, but outside the places a cell may edit.
		const bad =
			"diff --git a/packages/other/x.ts b/packages/other/x.ts\n--- a/packages/other/x.ts\n+++ b/packages/other/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
		writeFileSync(join(c.cellDir, "kept", "0001.patch"), bad);
		const m = model(NO_GAIN);
		const r = await runSelfImprove({
			...c,
			checks,
			env: cellEnv(),
			now: () => NOON,
			complete: m.complete,
		});
		expect(r.verdict).toBe("idle"); // the patch was not replayed, so the check still passes
		expect(m.calls).toEqual([]);
		expect(existsSync(join(c.cellDir, "kept", "0001.patch.stale"))).toBe(true);
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
		expect(validatePatch(ok)).toEqual({
			ok: true,
			files: ["packages/self-autonomy/skills/thing.ts"],
			changed: 2,
		});
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
		// The sandbox user, a root-only home, a genome the user cannot write, and the proof script.
		expect(docker).toMatch(
			/useradd --uid 1002 --no-create-home --shell \/usr\/sbin\/nologin cellrun/,
		);
		expect(docker).toMatch(/chmod 700 \/root/);
		expect(docker).toMatch(/chmod -R go-w \/app/);
		expect(docker).toMatch(/COPY scripts\/cell-sandbox-proof\.sh/);
	});

	test("CI builds the image and runs the sandbox proof in it", () => {
		const wf = readFileSync(
			join(import.meta.dir, "..", "..", ".github", "workflows", "cell-image.yml"),
			"utf-8",
		);
		expect(wf).toContain("docker build -t cell-image .");
		expect(wf).toContain("sh /app/scripts/cell-sandbox-proof.sh");
		expect(wf).toContain("no working sandbox");
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
			sandbox: "off",
		});
		expect(r.message).toBe("every named check passes; nothing to improve");
		expect(r.verdict).toBe("idle");
		expect(m.calls).toEqual([]);
	}, 120_000);
});

// ── second read (8SO, binding) ───────────────────────────────────────────────

const SK = "packages/self-autonomy/skills";
const hdr = (p: string) =>
	`diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`;

describe("a patch is parsed section by section: nothing git would apply goes unvalidated", () => {
	test("a second section with only ---/+++ lines (no diff --git header) is refused", () => {
		const sneaky = `${hdr(`${SK}/a.ts`)}--- a/packages/permissions/policy-engine.ts\n+++ b/packages/permissions/policy-engine.ts\n@@ -1 +1 @@\n-x\n+y\n`;
		const r = validatePatch(sneaky);
		expect(r.ok).toBe(false);
	});

	test("the ---/+++ paths must be the header's path (or /dev/null for a new or removed file)", () => {
		const wrong = `diff --git a/${SK}/a.ts b/${SK}/a.ts\n--- a/packages/decide/rules.ts\n+++ b/packages/decide/rules.ts\n@@ -1 +1 @@\n-a\n+b\n`;
		expect(validatePatch(wrong).ok).toBe(false);
		const added = `diff --git a/${SK}/n.md b/${SK}/n.md\nnew file mode 100644\n--- /dev/null\n+++ b/${SK}/n.md\n@@ -0,0 +1 @@\n+hello\n`;
		expect(validatePatch(added)).toEqual({ ok: true, files: [`${SK}/n.md`], changed: 1 });
		const removed = `diff --git a/${SK}/n.md b/${SK}/n.md\ndeleted file mode 100644\n--- a/${SK}/n.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-hello\n`;
		expect(validatePatch(removed).ok).toBe(true);
	});

	test("each of the ---/+++ lines is checked on its own, and a section with no hunk is refused", () => {
		const base = `diff --git a/${SK}/a.ts b/${SK}/a.ts\n`;
		expect(
			validatePatch(
				`${base}--- a/packages/decide/rules.ts\n+++ b/${SK}/a.ts\n@@ -1 +1 @@\n-a\n+b\n`,
			).ok,
		).toBe(false);
		expect(
			validatePatch(
				`${base}--- a/${SK}/a.ts\n+++ b/packages/decide/rules.ts\n@@ -1 +1 @@\n-a\n+b\n`,
			).ok,
		).toBe(false);
		expect(validatePatch(`${base}--- a/${SK}/a.ts\n+++ b/${SK}/a.ts\n`).ok).toBe(false);
		// A hunk that says it adds one line and then removes one.
		expect(validatePatch(`${base}--- a/${SK}/a.ts\n+++ b/${SK}/a.ts\n@@ -0,0 +1 @@\n-x\n`).ok).toBe(
			false,
		);
	});

	test("hunk bodies are read by their counts: a removed line that starts with -- is content, not a header", () => {
		const body = `diff --git a/${SK}/q.sql b/${SK}/q.sql\n--- a/${SK}/q.sql\n+++ b/${SK}/q.sql\n@@ -1,2 +1,2 @@\n--- a comment\n+-- another\n keep\n`;
		expect(validatePatch(body)).toEqual({ ok: true, files: [`${SK}/q.sql`], changed: 2 });
	});

	test("text before the first header, between sections, after the last hunk, or a hunk that is longer or shorter than it says, is refused", () => {
		expect(validatePatch(`Here you go:\n${hdr(`${SK}/a.ts`)}`).ok).toBe(false);
		expect(validatePatch(`${hdr(`${SK}/a.ts`)}some prose\n${hdr(`${SK}/b.ts`)}`).ok).toBe(false);
		expect(validatePatch(`${hdr(`${SK}/a.ts`)}trailing talk\n`).ok).toBe(false);
		expect(
			validatePatch(
				`diff --git a/${SK}/a.ts b/${SK}/a.ts\n--- a/${SK}/a.ts\n+++ b/${SK}/a.ts\n@@ -1 +1 @@\n-a\n+b\n+c\n`,
			).ok,
		).toBe(false);
		expect(
			validatePatch(
				`diff --git a/${SK}/a.ts b/${SK}/a.ts\n--- a/${SK}/a.ts\n+++ b/${SK}/a.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n`,
			).ok,
		).toBe(false);
		expect(validatePatch(`diff --git a/${SK}/a.ts b/${SK}/a.ts\n@@ -1 +1 @@\n-a\n+b\n`).ok).toBe(
			false,
		); // no ---/+++ at all
	});

	test("the limits count every section: 6 sections is too many, 201 lines spread over two is too many", () => {
		expect(
			validatePatch(Array.from({ length: 6 }, (_, i) => hdr(`${SK}/f${i}.ts`)).join("")).ok,
		).toBe(false);
		const sec = (n: number, name: string) =>
			`diff --git a/${SK}/${name} b/${SK}/${name}\n--- a/${SK}/${name}\n+++ b/${SK}/${name}\n@@ -0,0 +1,${n} @@\n${"+x\n".repeat(n)}`;
		expect(validatePatch(sec(100, "a.md") + sec(101, "b.md")).ok).toBe(false);
		expect(validatePatch(sec(100, "a.md") + sec(100, "b.md")).ok).toBe(true);
	});
});

describe("a cell may edit only skills, prompts and memory under packages/self-autonomy", () => {
	test("those three directories are the whole allow-list", () => {
		for (const d of ["skills", "prompts", "memory"])
			expect(validatePatch(hdr(`packages/self-autonomy/${d}/x.md`)).ok).toBe(true);
	});

	test("everything else is refused, whatever it is called", () => {
		for (const p of [
			"packages/decide/rules.ts",
			"packages/auth/session.ts",
			"packages/daemon/cron.ts",
			"packages/eight/tools.ts",
			"packages/permissions/policy-engine.ts",
			"packages/providers/index.ts",
			"packages/cron/routines.ts",
			"packages/self-autonomy/selfimprove.ts",
			"packages/self-autonomy/cell-checks.json",
			"packages/self-autonomy/reflection.ts",
			"packages/self-autonomy/skillsX/a.md",
			"packages/self-autonomy/skills",
			"packages/self-autonomy/skills/../selfimprove.ts",
			"packages/self-autonomy/skills/a.test.ts",
			"packages/self-autonomy/skills/.env",
			"bin/8gent.ts",
			"Dockerfile",
		])
			expect(validatePatch(hdr(p)).ok).toBe(false);
	});
});

describe("sandbox: model-written code never runs with the cell's powers", () => {
	test("on Linux the checks run in a network namespace as an unprivileged uid with no new privileges", () => {
		const sb = linuxSandbox(1234);
		expect(sb.wrap(["bun", "test", "x.ts"])).toEqual([
			"unshare",
			"-n",
			"setpriv",
			"--reuid=1234",
			"--regid=1234",
			"--clear-groups",
			"--no-new-privs",
			"--",
			"bun",
			"test",
			"x.ts",
		]);
		expect(() => linuxSandbox(0)).toThrow();
		expect(() => linuxSandbox(-1)).toThrow();
	});

	test("with no working sandbox the round is refused before anything runs, and no call is made", async () => {
		const c = cell();
		let ran = 0;
		const m = model(FIX);
		const r = await runSelfImprove({
			...c,
			sandbox: { probe: async () => false, prepare: () => {}, wrap: (a) => a },
			env: cellEnv(),
			now: () => NOON,
			complete: m.complete,
			runCheck: async () => {
				ran++;
				return { pass: true, tail: "" };
			},
		});
		expect(r.verdict).toBe("refused");
		expect(r.message).toMatch(/sandbox/i);
		expect(ran).toBe(0);
		expect(m.calls).toEqual([]);
	});

	test("SELFIMPROVE_UNSANDBOXED=1 is the one explicit way to run without it", async () => {
		const c = cell();
		const { sandbox: _s, ...rest } = c;
		const r = await runSelfImprove({
			...rest,
			env: cellEnv({ SELFIMPROVE_UNSANDBOXED: "1" }),
			now: () => NOON,
			complete: model(FIX).complete,
		});
		expect(r.verdict).toBe("kept");
	});

	test("every check, baseline and after, goes through the sandbox in a scratch directory outside the cell state and the genome", async () => {
		const c = cell();
		const wrapped: string[][] = [];
		const prepared: string[] = [];
		const r = await runSelfImprove({
			...c,
			sandbox: {
				probe: async () => true,
				prepare: (dir) => prepared.push(dir),
				wrap: (a) => {
					wrapped.push(a);
					return a;
				},
			},
			env: cellEnv(),
			now: () => NOON,
			complete: model(FIX).complete,
		});
		expect(r.verdict).toBe("kept");
		expect(wrapped.length).toBe(c.checks.length * 2);
		expect(prepared.length).toBe(2); // before the baseline, and again after the patch
		expect(new Set(prepared).size).toBe(1);
		expect(prepared[0].startsWith(c.cellDir)).toBe(false);
		expect(prepared[0].startsWith(c.workspace)).toBe(false);
		expect(prepared[0].startsWith(tmpdir())).toBe(true);
	});
});

describe("the key: never in the process environment, resolved only for the call", () => {
	const fakeFetch = () => {
		const seen: { url: string; auth: string | undefined }[] = [];
		const fetchImpl = async (url: string, init?: RequestInit) => {
			seen.push({
				url,
				auth: (init?.headers as Record<string, string> | undefined)?.authorization,
			});
			return Response.json({
				choices: [{ message: { content: FIX } }],
				usage: { total_tokens: 640 },
			});
		};
		return { seen, fetchImpl };
	};

	test("a key in the environment is taken out of it before any check runs, and still reaches the model call", async () => {
		const c = cell();
		const env: Record<string, string | undefined> = {
			...cellEnv({ SELFIMPROVE_MODEL: "m-1" }),
			MINIMAX_API_KEY: "k-from-env",
		};
		const f = fakeFetch();
		let envSeenByChecks: string | undefined = "unset";
		const r = await runSelfImprove({
			...c,
			env,
			now: () => NOON,
			fetchImpl: f.fetchImpl,
			runCheck: async (def) => {
				envSeenByChecks = env.MINIMAX_API_KEY;
				return { pass: def.name === "keep-file", tail: "" };
			},
		});
		expect(envSeenByChecks).toBeUndefined();
		expect(env.MINIMAX_API_KEY).toBeUndefined();
		expect(f.seen[0].auth).toBe("Bearer k-from-env");
		expect(r.tokens).toBe(640);
	});

	test("MINIMAX_API_KEY_FILE is read when the call is made, after the baseline checks", async () => {
		const c = cell();
		const keyFile = join(tmp(), "key");
		const f = fakeFetch();
		const r = await runSelfImprove({
			...c,
			env: cellEnv({ SELFIMPROVE_MODEL: "m-1", MINIMAX_API_KEY_FILE: keyFile }),
			now: () => NOON,
			fetchImpl: f.fetchImpl,
			runCheck: async (def) => {
				// The file does not exist until a check has run: reading it earlier would have failed.
				if (!existsSync(keyFile)) writeFileSync(keyFile, "k-from-file\n");
				return { pass: def.name === "keep-file", tail: "" };
			},
		});
		expect(f.seen[0].auth).toBe("Bearer k-from-file");
		expect(r.tokens).toBe(640);
	});

	test("no key anywhere: the round stops before the call with a plain line, and spends nothing", async () => {
		const c = cell();
		const f = fakeFetch();
		const r = await runSelfImprove({
			...c,
			env: cellEnv({ SELFIMPROVE_MODEL: "m-1" }),
			now: () => NOON,
			fetchImpl: f.fetchImpl,
		});
		expect(r.verdict).toBe("refused");
		expect(r.message).toMatch(/key/i);
		expect(f.seen).toEqual([]);
		expect(r.tokens).toBe(0);
	});
});

describe("tokens are logged even when the call fails after spending", () => {
	test("a call that throws is charged the max_tokens it was given", async () => {
		const c = cell();
		const seen: number[] = [];
		const r = await runSelfImprove({
			...c,
			env: cellEnv(),
			now: () => NOON,
			complete: async (_p, o) => {
				seen.push(o.maxTokens);
				throw new Error("socket hang up");
			},
		});
		expect(r.verdict).toBe("refused");
		expect(r.tokens).toBe(seen[0]);
		expect(spentToday(readLedger(c.cellDir), NOON)).toBe(seen[0]);
	});

	test("a failure that carries the API's usage is charged that usage", async () => {
		const c = cell();
		const r = await runSelfImprove({
			...c,
			env: cellEnv(),
			now: () => NOON,
			complete: async () => {
				throw new CallError("answered with no text", 321);
			},
		});
		expect(r.tokens).toBe(321);
		expect(spentToday(readLedger(c.cellDir), NOON)).toBe(321);
	});

	test("the real MiniMax call: a 200 with no text carries its usage, a 500 and a dead socket are charged max_tokens", async () => {
		const run = (f: () => Response | Promise<Response>) =>
			minimaxComplete(
				"x",
				{ maxTokens: 900 },
				{ baseUrl: "https://api.minimax.io/v1", key: "k", model: "m", fetchImpl: async () => f() },
			);
		const e1 = await run(() => Response.json({ choices: [], usage: { total_tokens: 55 } })).catch(
			(e) => e as CallError,
		);
		expect(e1).toBeInstanceOf(CallError);
		expect((e1 as CallError).tokens).toBe(55);
		const e2 = await run(() => new Response("boom", { status: 500 })).catch((e) => e as CallError);
		expect((e2 as CallError).tokens).toBe(900);
		const e3 = await run(() => {
			throw new Error("ECONNRESET");
		}).catch((e) => e as CallError);
		expect((e3 as CallError).tokens).toBe(900);
		// Refused before anything was sent: nothing charged.
		const e4 = await minimaxComplete(
			"x",
			{ maxTokens: 900 },
			{ baseUrl: "http://x/v1", key: "k", model: "m" },
		).catch((e) => e as Error);
		expect(e4).not.toBeInstanceOf(CallError);
	});

	test("the day's cap still holds after a failed call: the next round sees the spend", async () => {
		const c = cell();
		await runSelfImprove({
			...c,
			env: cellEnv({ DAILY_TOKEN_CAP: "5000" }),
			now: () => NOON,
			complete: async () => {
				throw new CallError("late failure", 4500);
			},
		});
		const m = model(FIX);
		const r = await runSelfImprove({
			...c,
			env: cellEnv({ DAILY_TOKEN_CAP: "5000" }),
			now: () => NOON,
			complete: m.complete,
		});
		expect(r.verdict).toBe("dormant");
		expect(m.calls).toEqual([]);
	});
});
