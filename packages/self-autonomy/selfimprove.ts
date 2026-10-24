/**
 * /selfimprove, minimal (#4937): one round on a vessel cell.
 *
 *   1. run the cell's frozen check suite (named checks, each a command; exit 0 passes);
 *   2. ask the model for ONE change, as a unified diff, for the checks that fail;
 *   3. apply it in a scratch copy and rerun the suite;
 *   4. keep it only if no named check that passed now fails and at least one now passes;
 *   5. write a ledger line: energy (tokens) spent against the checks improved.
 *
 * Energy: DAILY_TOKEN_CAP is a hard limit enforced here, in the process. The model call is given
 * max_tokens = what is left today minus the prompt estimate, so it cannot pass the cap; once the
 * day's tokens are spent the cell is dormant until 00:00 UTC. No cap, no round.
 *
 * A kept change is saved as a patch on the cell's own volume (<home>/.8gent/cell/kept) and applied
 * to every later scratch copy; the genome itself is never edited. Nothing is sent anywhere here:
 * no proposal goes out in this slice.
 *
 * Cells only: CELL_ID must be set and the provider must be minimax, our own fleet's explicit choice.
 * A person's install never uses a hosted model for this, and nothing here asks them to.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home";

type Env = Record<string, string | undefined>;

export interface CheckDef {
	name: string;
	/** argv, run in the scratch copy. Exit 0 passes. */
	cmd: string[];
}
export interface CheckResult {
	pass: boolean;
	/** The end of the output, for the model and the ledger. */
	tail: string;
}
export type Verdict = "kept" | "reverted" | "refused" | "idle" | "dormant";
export interface LedgerLine {
	ts: string;
	cell: string;
	round: number;
	tokens: number;
	improved: string[];
	regressed: string[];
	verdict: Verdict;
	patch?: string;
	suite?: string;
	note?: string;
}
export interface RoundResult {
	verdict: Verdict;
	tokens: number;
	improved: string[];
	regressed: string[];
	message: string;
}
export type Complete = (
	prompt: string,
	o: { maxTokens: number },
) => Promise<{ text: string; tokens: number | null }>;

export interface RoundDeps {
	env?: Env;
	now?: () => Date;
	/** The genome: a checkout or the image's /app. Never edited. */
	workspace?: string;
	/** The cell's own state: ledger, kept patches. Default <home>/.8gent/cell. */
	cellDir?: string;
	checks?: CheckDef[];
	runCheck?: (c: CheckDef, cwd: string) => Promise<CheckResult>;
	complete?: Complete;
}

export const DEFAULT_MIN_CALL_TOKENS = 1000;
const MAX_COMPLETION = 4096;
const MAX_FILES = 5;
const MAX_CHANGED = 200;
// bin/ too: the routines checks look for the CLI entry beside packages/.
const COPY = ["packages", "bin", "tests", "package.json", "tsconfig.json"];

// ── ledger and energy ────────────────────────────────────────────────────

const ledgerPath = (cellDir: string) => path.join(cellDir, "energy.jsonl");

export function readLedger(cellDir: string): LedgerLine[] {
	try {
		return fs
			.readFileSync(ledgerPath(cellDir), "utf-8")
			.split("\n")
			.filter(Boolean)
			.flatMap((l) => {
				try {
					return [JSON.parse(l) as LedgerLine];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

function appendLedger(cellDir: string, line: LedgerLine): void {
	fs.mkdirSync(cellDir, { recursive: true, mode: 0o700 });
	const fd = fs.openSync(
		ledgerPath(cellDir),
		fs.constants.O_WRONLY |
			fs.constants.O_APPEND |
			fs.constants.O_CREAT |
			(fs.constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		fs.writeSync(fd, `${JSON.stringify(line)}\n`);
		fs.fchmodSync(fd, 0o600);
	} finally {
		fs.closeSync(fd);
	}
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Tokens spent on this UTC day. */
export function spentToday(lines: LedgerLine[], now: Date): number {
	const day = utcDay(now);
	return lines.filter((l) => l.ts.slice(0, 10) === day).reduce((n, l) => n + (l.tokens || 0), 0);
}

function capFrom(env: Env): { cap: number } | { error: string } {
	const raw = env.DAILY_TOKEN_CAP?.trim() ?? "";
	const ceilRaw = env.HARD_CAP_CEILING?.trim() || "500000";
	if (!/^\d+$/.test(raw) || Number(raw) < 1)
		return { error: "DAILY_TOKEN_CAP must be a positive number: no cap, no round" };
	if (!/^\d+$/.test(ceilRaw)) return { error: "HARD_CAP_CEILING is not a number" };
	if (Number(raw) > Number(ceilRaw))
		return { error: `DAILY_TOKEN_CAP ${raw} is above the ceiling ${ceilRaw}` };
	return { cap: Number(raw) };
}

// ── patches ──────────────────────────────────────────────────────────────

const DENY: RegExp[] = [
	/\.test\.tsx?$/,
	/(^|\/)__tests__\//,
	/cell-checks\.json$/,
	/^packages\/permissions\//,
	/^packages\/decide\/(guard|rules)/,
	/^packages\/providers\//,
	/^packages\/self-autonomy\/selfimprove/,
	/(^|\/)\.env/,
	/secret/i,
	/node_modules/,
	/(^|\/)\.git(\/|$)/,
	/(^|\/)(Dockerfile|package\.json|bun\.lock)/,
];

export type PatchCheck =
	| { ok: true; files: string[]; changed: number }
	| { ok: false; why: string };

/** What a cell will apply: a few small source edits under packages/, never the checks, the guard, the keys or this loop. */
export function validatePatch(text: string): PatchCheck {
	if (!/^diff --git /m.test(text)) return { ok: false, why: "no diff in the answer" };
	if (/^(GIT binary patch|Binary files )/m.test(text))
		return { ok: false, why: "binary patches are refused" };
	if (
		/^(old mode|new mode|rename |copy |similarity |new file mode 120000|deleted file mode 120000)/m.test(
			text,
		)
	)
		return { ok: false, why: "modes, renames, copies and symlinks are refused" };
	const files: string[] = [];
	for (const m of text.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
		const [, a, b] = m;
		if (a !== b) return { ok: false, why: "a rename is refused" };
		if (b.startsWith("/") || b.includes("\\") || b.includes("\0") || b.split("/").includes(".."))
			return { ok: false, why: `path leaves the tree: ${b.slice(0, 60)}` };
		if (!b.startsWith("packages/"))
			return { ok: false, why: `only packages/ may change: ${b.slice(0, 60)}` };
		if (DENY.some((r) => r.test(b))) return { ok: false, why: `${b} is not for a cell to change` };
		files.push(b);
	}
	if (files.length === 0) return { ok: false, why: "no files in the diff" };
	if (files.length > MAX_FILES) return { ok: false, why: `more than ${MAX_FILES} files` };
	let changed = 0;
	for (const l of text.split("\n")) {
		if (/^(\+\+\+ |--- )(a\/|b\/|\/dev\/null)/.test(l)) continue;
		if (l.startsWith("+") || l.startsWith("-")) changed++;
	}
	if (changed > MAX_CHANGED) return { ok: false, why: `more than ${MAX_CHANGED} changed lines` };
	return { ok: true, files, changed };
}

/** The diff in a model answer: fences and talk around it removed. */
export function extractDiff(answer: string): string {
	const i = answer.indexOf("diff --git ");
	if (i < 0) return "";
	let t = answer.slice(i);
	const fence = t.indexOf("\n```");
	if (fence >= 0) t = t.slice(0, fence + 1);
	return t.endsWith("\n") ? t : `${t}\n`;
}

function gitApply(cwd: string, patchFile: string, checkOnly: boolean): boolean {
	const args = [
		"apply",
		"-p1",
		"--whitespace=nowarn",
		...(checkOnly ? ["--check"] : []),
		patchFile,
	];
	return spawnSync("git", args, { cwd, stdio: "ignore", timeout: 30_000 }).status === 0;
}

// ── checks ───────────────────────────────────────────────────────────────

/** The only variables a check inherits. The model's key is not one of them. */
const CHECK_ENV = ["PATH", "LANG", "LC_ALL", "TMPDIR", "TZ"] as const;

async function defaultRunCheck(c: CheckDef, cwd: string): Promise<CheckResult> {
	const env: Record<string, string> = { HOME: cwd };
	for (const k of CHECK_ENV) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
	const r = spawnSync(c.cmd[0], c.cmd.slice(1), {
		cwd,
		env: env as NodeJS.ProcessEnv,
		encoding: "utf-8",
		timeout: 180_000,
	});
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	return { pass: r.status === 0, tail: out.slice(-4000) };
}

function suiteHash(checks: CheckDef[]): string {
	return createHash("sha256")
		.update(JSON.stringify(checks.map((c) => [c.name, c.cmd])))
		.digest("hex")
		.slice(0, 16);
}

export function loadChecks(workspace: string): CheckDef[] {
	const f = path.join(workspace, "packages", "self-autonomy", "cell-checks.json");
	return (JSON.parse(fs.readFileSync(f, "utf-8")) as { checks: CheckDef[] }).checks;
}

// ── scratch ──────────────────────────────────────────────────────────────

function makeScratch(workspace: string, cellDir: string): string {
	const dir = path.join(cellDir, `scratch-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const e of COPY) {
		const src = path.join(workspace, e);
		if (!fs.existsSync(src)) continue;
		fs.cpSync(src, path.join(dir, e), {
			recursive: true,
			filter: (s) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s),
		});
	}
	const nm = path.join(workspace, "node_modules");
	if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(dir, "node_modules"));
	return dir;
}

function applyKept(scratch: string, cellDir: string): void {
	const dir = path.join(cellDir, "kept");
	if (!fs.existsSync(dir)) return;
	for (const n of fs
		.readdirSync(dir)
		.filter((x) => x.endsWith(".patch"))
		.sort()) {
		const f = path.join(dir, n);
		if (gitApply(scratch, f, true)) gitApply(scratch, f, false);
		else fs.renameSync(f, `${f}.stale`); // the genome moved on; this patch no longer applies
	}
}

// ── the model ────────────────────────────────────────────────────────────

const estimate = (s: string) => Math.ceil(s.length / 3);

function buildPrompt(failing: Array<{ name: string; tail: string }>, scratch: string): string {
	const parts = [
		"You are improving a code base. Each named check below fails. Reply with ONE unified diff (git format, paths a/<path> and b/<path> from the repo root) that makes at least one of them pass without breaking anything else, and nothing but the diff.",
		"Do not edit tests, check lists, permissions, secrets, Dockerfiles or package files. At most 5 files and 200 changed lines.",
		"",
	];
	const files = new Set<string>();
	for (const f of failing.slice(0, 5)) {
		parts.push(`## failing check: ${f.name}`, f.tail.slice(-2000), "");
		for (const m of f.tail.matchAll(/packages\/[A-Za-z0-9_./-]+\.(?:ts|tsx|json)/g))
			if (!/\.test\./.test(m[0])) files.add(m[0]);
	}
	for (const rel of [...files].slice(0, 3)) {
		const abs = path.resolve(scratch, rel);
		if (!abs.startsWith(`${scratch}${path.sep}`) || !fs.existsSync(abs)) continue;
		parts.push(`## ${rel}`, fs.readFileSync(abs, "utf-8").split("\n").slice(0, 120).join("\n"), "");
	}
	return parts.join("\n");
}

export interface MinimaxOpts {
	baseUrl: string;
	key: string;
	model: string;
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** MiniMax's OpenAI-compatible chat completions, at the registry's base URL. https only; no redirect. */
export async function minimaxComplete(
	prompt: string,
	o: { maxTokens: number },
	m: MinimaxOpts,
): Promise<{ text: string; tokens: number | null }> {
	if (!m.baseUrl.startsWith("https://")) throw new Error("the model endpoint must be https");
	const f = m.fetchImpl ?? ((u, i) => fetch(u, i));
	const res = await f(`${m.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${m.key}` },
		body: JSON.stringify({
			model: m.model,
			messages: [{ role: "user", content: prompt }],
			max_tokens: o.maxTokens,
			temperature: 0.2,
		}),
		redirect: "error",
		signal: AbortSignal.timeout(180_000),
	});
	if (!res.ok) throw new Error(`the model endpoint answered ${res.status}`);
	const j = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
		usage?: { total_tokens?: number };
	};
	const text = j.choices?.[0]?.message?.content;
	if (typeof text !== "string" || text === "") throw new Error("the model answered with no text");
	const t = j.usage?.total_tokens;
	return { text, tokens: typeof t === "number" && Number.isFinite(t) ? t : null };
}

async function defaultComplete(env: Env): Promise<Complete> {
	const { resolveProviderBaseUrl, resolveProviderKey } = await import("../providers/key-resolver");
	const baseUrl = resolveProviderBaseUrl("minimax");
	const key = resolveProviderKey("minimax");
	if (!baseUrl || !key) throw new Error("no MiniMax key: set MINIMAX_API_KEY on this cell");
	let model = env.SELFIMPROVE_MODEL?.trim();
	if (!model) {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
			headers: { authorization: `Bearer ${key}` },
			redirect: "error",
			signal: AbortSignal.timeout(30_000),
		});
		const list = (await res.json()) as { data?: Array<{ id?: string }> };
		model = list.data?.find((x) => typeof x.id === "string")?.id;
		if (!model) throw new Error("the model endpoint listed no models");
	}
	return (p, o) => minimaxComplete(p, o, { baseUrl, key, model: model as string });
}

// ── the round ────────────────────────────────────────────────────────────

const done = (
	verdict: Verdict,
	message: string,
	extra: Partial<RoundResult> = {},
): RoundResult => ({
	verdict,
	tokens: 0,
	improved: [],
	regressed: [],
	message,
	...extra,
});

export async function runSelfImprove(deps: RoundDeps = {}): Promise<RoundResult> {
	const env = deps.env ?? process.env;
	const now = deps.now ?? (() => new Date());
	if (!env.CELL_ID?.trim())
		return done(
			"refused",
			"selfimprove runs only inside a vessel cell (CELL_ID), by our own fleet's choice; nothing was run or sent",
		);
	if (env.SELFIMPROVE_PROVIDER?.trim() !== "minimax")
		return done(
			"refused",
			"selfimprove in a cell uses the minimax provider only (SELFIMPROVE_PROVIDER=minimax)",
		);
	const capped = capFrom(env);
	if ("error" in capped) return done("refused", capped.error);
	const cap = capped.cap;

	const workspace = deps.workspace ?? path.resolve(import.meta.dir, "..", "..");
	const cellDir = deps.cellDir ?? path.join(resolveHome(env), ".8gent", "cell");
	const cell = env.CELL_ID.trim();
	const checks = deps.checks ?? loadChecks(workspace);
	const runCheck = deps.runCheck ?? defaultRunCheck;
	const t = now();

	// Frozen: the suite a cell started with is the suite it keeps.
	const suite = suiteHash(checks);
	const shaFile = path.join(cellDir, "suite.sha");
	fs.mkdirSync(cellDir, { recursive: true, mode: 0o700 });
	if (fs.existsSync(shaFile)) {
		if (fs.readFileSync(shaFile, "utf-8").trim() !== suite)
			return done(
				"refused",
				"the check suite changed since this cell started; it is frozen. Replace the cell to change it",
			);
	} else fs.writeFileSync(shaFile, `${suite}\n`, { mode: 0o600 });

	const lines = readLedger(cellDir);
	const round = lines.length + 1;
	const spent = spentToday(lines, t);
	const log = (l: Omit<LedgerLine, "ts" | "cell" | "round" | "suite">) =>
		appendLedger(cellDir, { ts: t.toISOString(), cell, round, suite, ...l });

	if (spent >= cap) return dormant(lines, t, cellDir, log, `today's ${cap} tokens are spent`);

	const scratch = makeScratch(workspace, cellDir);
	let tokens = 0;
	try {
		applyKept(scratch, cellDir);
		const base = new Map<string, CheckResult>();
		for (const c of checks) base.set(c.name, await runCheck(c, scratch));
		const failing = checks
			.filter((c) => !base.get(c.name)?.pass)
			.map((c) => ({ name: c.name, tail: base.get(c.name)?.tail ?? "" }));
		if (failing.length === 0) {
			log({ tokens: 0, improved: [], regressed: [], verdict: "idle", note: "every check passes" });
			return done("idle", "every named check passes; nothing to improve");
		}

		const prompt = buildPrompt(failing, scratch);
		const remaining = cap - spent;
		const maxTokens = Math.min(MAX_COMPLETION, remaining - estimate(prompt));
		if (remaining - estimate(prompt) < DEFAULT_MIN_CALL_TOKENS)
			return dormant(
				lines,
				t,
				cellDir,
				log,
				`${remaining} tokens left today is not enough for a round`,
			);
		const complete = deps.complete ?? (await defaultComplete(env));
		const reply = await complete(prompt, { maxTokens });
		tokens = reply.tokens ?? estimate(prompt) + estimate(reply.text);

		const patch = extractDiff(reply.text);
		const ok = validatePatch(patch);
		if (!ok.ok) {
			log({ tokens, improved: [], regressed: [], verdict: "refused", note: ok.why });
			return done("refused", ok.why, { tokens });
		}
		const patchFile = path.join(scratch, ".round.patch");
		fs.writeFileSync(patchFile, patch);
		if (!gitApply(scratch, patchFile, true) || !gitApply(scratch, patchFile, false)) {
			log({
				tokens,
				improved: [],
				regressed: [],
				verdict: "reverted",
				note: "the change did not apply",
			});
			return done("reverted", "the change did not apply", { tokens });
		}
		const improved: string[] = [];
		const regressed: string[] = [];
		for (const c of checks) {
			const before = base.get(c.name)?.pass === true;
			const after = (await runCheck(c, scratch)).pass;
			if (!before && after) improved.push(c.name);
			if (before && !after) regressed.push(c.name);
		}
		if (regressed.length === 0 && improved.length > 0) {
			const dir = path.join(cellDir, "kept");
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			const name = `${t.toISOString().replace(/[:.]/g, "-")}-r${round}.patch`;
			fs.writeFileSync(path.join(dir, name), patch, { mode: 0o600 });
			log({ tokens, improved, regressed, verdict: "kept", patch: name });
			return done("kept", `kept ${name}: improved ${improved.join(", ")}`, {
				tokens,
				improved,
				regressed,
			});
		}
		log({
			tokens,
			improved,
			regressed,
			verdict: "reverted",
			note: regressed.length ? "a check regressed" : "nothing improved",
		});
		return done(
			"reverted",
			regressed.length
				? `reverted: regressed ${regressed.join(", ")}`
				: "reverted: nothing improved",
			{
				tokens,
				improved,
				regressed,
			},
		);
	} catch (err) {
		// A failed call may still have spent tokens; whatever was spent is on the ledger.
		log({
			tokens,
			improved: [],
			regressed: [],
			verdict: "refused",
			note: (err as Error).message.slice(0, 200),
		});
		return done("refused", `round stopped: ${(err as Error).message}`, { tokens });
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

function dormant(
	lines: LedgerLine[],
	t: Date,
	_cellDir: string,
	log: (l: Omit<LedgerLine, "ts" | "cell" | "round" | "suite">) => void,
	why: string,
): RoundResult {
	const day = utcDay(t);
	const already = lines.some((l) => l.verdict === "dormant" && l.ts.slice(0, 10) === day);
	if (!already) log({ tokens: 0, improved: [], regressed: [], verdict: "dormant", note: why });
	return done("dormant", `dormant until 00:00 UTC: ${why}`);
}

// ── the command ──────────────────────────────────────────────────────────

/** `8gent selfimprove`. Exit 0 when a round ran or the cell rested, 1 when it was refused. */
export async function selfImproveCommand(
	_args: string[],
	deps: RoundDeps & { say?: (l: string) => void } = {},
): Promise<number> {
	const say = deps.say ?? ((l: string) => console.log(l));
	const r = await runSelfImprove(deps);
	say(`selfimprove: ${r.verdict}. ${r.message}${r.tokens ? ` (${r.tokens} tokens)` : ""}`);
	return r.verdict === "refused" ? 1 : 0;
}
