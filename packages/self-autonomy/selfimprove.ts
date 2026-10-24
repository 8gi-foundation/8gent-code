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
 * The model's code never runs with the cell's powers: the checks (and so any patched code) run in a
 * sandbox (linuxSandbox: a network namespace, an unprivileged uid, no new privileges) in a scratch
 * directory outside the cell state and the genome. The round is refused where no sandbox works, unless
 * SELFIMPROVE_UNSANDBOXED=1, and then the key and the ledger are only as safe as the model. The model's
 * key is taken out of the process environment at the start of the round and read again only for the call
 * (MINIMAX_API_KEY_FILE is read at the call itself). Not yet proven in the Fly image: see
 * scripts/cell-sandbox-proof.sh and .github/workflows/cell-image.yml.
 *
 * Cells only: CELL_ID must be set and the provider must be minimax, our own fleet's explicit choice.
 * A person's install never uses a hosted model for this, and nothing here asks them to.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
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

/** Where model-written code runs. */
export interface Sandbox {
	/** True only when the isolation really works on this machine. */
	probe(): Promise<boolean>;
	/** Give the scratch directory to the sandbox user. */
	prepare(dir: string): void;
	/** The argv that runs `argv` inside the sandbox. */
	wrap(argv: string[]): string[];
}

/** Thrown by a model call that failed after it may have spent tokens: `tokens` is what to charge. */
export class CallError extends Error {
	constructor(
		message: string,
		readonly tokens: number,
	) {
		super(message);
	}
}

/** Thrown before anything was sent: nothing is charged. */
export class PreCallError extends Error {}

export interface RoundDeps {
	env?: Env;
	now?: () => Date;
	/** The genome: a checkout or the image's /app. Never edited. */
	workspace?: string;
	/** The cell's own state: ledger, kept patches. Default <home>/.8gent/cell. */
	cellDir?: string;
	checks?: CheckDef[];
	/** Where the warning for an unsandboxed round goes. Default: stderr. */
	warn?: (line: string) => void;
	/** Replaces the sandboxed check runner (tests). */
	runCheck?: (c: CheckDef, cwd: string) => Promise<CheckResult>;
	complete?: Complete;
	/** "off" runs checks directly (tests, or SELFIMPROVE_UNSANDBOXED=1). Default: linuxSandbox(). */
	sandbox?: Sandbox | "off";
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export const UNSANDBOXED_WARNING =
	"selfimprove: UNSANDBOXED. Model-written code runs with this cell's own powers, so its key and its ledger are only as safe as the model.";

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

/** The only places a cell may edit: its skills, its prompts, its memory. */
const ALLOW_DIRS = [
	"packages/self-autonomy/skills/",
	"packages/self-autonomy/prompts/",
	"packages/self-autonomy/memory/",
];

function pathProblem(p: string): string | null {
	if (p.includes("\\") || p.includes("\0") || p.startsWith("/") || p.split("/").includes(".."))
		return `path leaves the tree: ${p.slice(0, 60)}`;
	if (!ALLOW_DIRS.some((d) => p.startsWith(d) && p.length > d.length))
		return `${p.slice(0, 60)} is outside the places a cell may edit (skills, prompts, memory)`;
	if (/\.test\.tsx?$/.test(p) || /(^|\/)\.env/.test(p) || /node_modules|(^|\/)\.git(\/|$)/.test(p))
		return `${p.slice(0, 60)} is not for a cell to change`;
	return null;
}

export type PatchCheck =
	| { ok: true; files: string[]; changed: number }
	| { ok: false; why: string };

/**
 * What a cell will apply, read section by section so that nothing git would apply goes unchecked:
 * every section opens with a `diff --git a/P b/P` header, its ---/+++ lines must name that same P (or
 * /dev/null for an added or removed file), and its hunks are read by their counts. Any other line, before,
 * between or after the sections, is a refusal. Only the allow-listed directories; at most 5 files and 200
 * changed lines in all.
 */
export function validatePatch(text: string): PatchCheck {
	const lines = text.split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const no = (why: string): PatchCheck => ({ ok: false, why });
	if (lines.length === 0) return no("no diff in the answer");
	const files: string[] = [];
	let changed = 0;
	let i = 0;
	while (i < lines.length) {
		const m = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[i]);
		if (!m) return no(`line ${i + 1} is outside any diff section: ${lines[i].slice(0, 40)}`);
		const [, a, b] = m;
		if (a !== b) return no("a rename is refused");
		const problem = pathProblem(b);
		if (problem) return no(problem);
		i++;
		let added = false;
		let removed = false;
		while (i < lines.length && !lines[i].startsWith("--- ")) {
			const l = lines[i];
			if (/^index [0-9a-f]+\.\.[0-9a-f]+( 100644)?$/.test(l)) {
				// fine
			} else if (l === "new file mode 100644") added = true;
			else if (l === "deleted file mode 100644") removed = true;
			else return no(`unsupported line in the header of ${b}: ${l.slice(0, 40)}`);
			i++;
		}
		const minus = /^--- (?:a\/(.+)|(\/dev\/null))$/.exec(lines[i] ?? "");
		const plus = /^\+\+\+ (?:b\/(.+)|(\/dev\/null))$/.exec(lines[i + 1] ?? "");
		if (!minus || !plus) return no(`${b} has no ---/+++ lines`);
		if (added ? !minus[2] : minus[1] !== b) return no(`the --- line of ${b} names another file`);
		if (removed ? !plus[2] : plus[1] !== b) return no(`the +++ line of ${b} names another file`);
		i += 2;
		let hunks = 0;
		while (i < lines.length && lines[i].startsWith("@@ ")) {
			const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]);
			if (!h) return no(`bad hunk header in ${b}`);
			let oldN = h[1] === undefined ? 1 : Number(h[1]);
			let newN = h[2] === undefined ? 1 : Number(h[2]);
			i++;
			hunks++;
			while (oldN > 0 || newN > 0) {
				if (i >= lines.length) return no(`a hunk in ${b} is shorter than it says`);
				const l = lines[i];
				if (l.startsWith("\\")) {
					i++;
					continue;
				}
				const c = l === "" ? " " : l[0];
				if (c === " ") {
					oldN--;
					newN--;
				} else if (c === "-") {
					oldN--;
					changed++;
				} else if (c === "+") {
					newN--;
					changed++;
				} else return no(`bad line in a hunk of ${b}`);
				if (oldN < 0 || newN < 0) return no(`a hunk in ${b} is longer than it says`);
				i++;
			}
			while (i < lines.length && lines[i].startsWith("\\")) i++;
		}
		if (hunks === 0) return no(`${b} has no hunk`);
		files.push(b);
	}
	if (files.length > MAX_FILES) return no(`more than ${MAX_FILES} files`);
	if (changed > MAX_CHANGED) return no(`more than ${MAX_CHANGED} changed lines`);
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

function sandboxedRunCheck(wrap: (a: string[]) => string[]) {
	return async (c: CheckDef, cwd: string): Promise<CheckResult> => {
		const env: Record<string, string> = { HOME: cwd };
		for (const k of CHECK_ENV) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
		const argv = wrap(c.cmd);
		const r = spawnSync(argv[0], argv.slice(1), {
			cwd,
			env: env as NodeJS.ProcessEnv,
			encoding: "utf-8",
			timeout: 180_000,
		});
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
		return { pass: r.status === 0, tail: out.slice(-4000) };
	};
}

/**
 * Linux isolation for model-written code: a new network namespace (no network), then drop to an
 * unprivileged uid with no new privileges. The cell's state, key file and ledger live under the
 * root-only home, and its environment is in root-only /proc files, so that uid cannot read them. Needs
 * root with CAP_SYS_ADMIN (a Fly machine; a default Docker container has neither).
 */
export function linuxSandbox(
	uid: number = Number(process.env.CELL_SANDBOX_UID ?? 1002),
	opts: { keyFile?: string; platform?: string; run?: (argv: string[]) => number | null } = {},
): Sandbox {
	const run =
		opts.run ??
		((argv: string[]) =>
			spawnSync(argv[0], argv.slice(1), { stdio: "ignore", timeout: 20_000 }).status);
	if (!Number.isInteger(uid) || uid < 1) throw new Error("the sandbox needs an unprivileged uid");
	const wrap = (argv: string[]) => [
		"unshare",
		"-n",
		"setpriv",
		`--reuid=${uid}`,
		`--regid=${uid}`,
		"--clear-groups",
		"--no-new-privs",
		"--",
		...argv,
	];
	return {
		wrap,
		prepare(dir: string) {
			const walk = (d: string) => {
				fs.chownSync(d, uid, uid);
				for (const e of fs.readdirSync(d, { withFileTypes: true })) {
					const f = path.join(d, e.name);
					if (e.isSymbolicLink()) fs.lchownSync(f, uid, uid);
					else if (e.isDirectory()) walk(f);
					else fs.chownSync(f, uid, uid);
				}
			};
			walk(dir);
			fs.chmodSync(dir, 0o700);
		},
		async probe() {
			if ((opts.platform ?? process.platform) !== "linux") return false;
			// Right uid, only the loopback device, root's environment and root's home unreadable.
			const script = [
				`[ "$(id -u)" = "${uid}" ]`,
				`[ "$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ')" = "lo" ]`,
				"! cat /proc/1/environ > /dev/null 2>&1",
				"! ls /root > /dev/null 2>&1",
			].join(" && ");
			if (run(wrap(["sh", "-c", script])) !== 0) return false;
			// The configured key file must be out of the sandbox user's reach: if that uid can read it, there is no sandbox.
			// The path is an argument, never part of the script text.
			if (
				opts.keyFile &&
				run(wrap(["sh", "-c", '! cat "$1" > /dev/null 2>&1', "sh", opts.keyFile])) !== 0
			)
				return false;
			return true;
		},
	};
}

/** The sandbox a cell uses: linuxSandbox, probing the configured key file as well. */
export function defaultSandbox(env: Env, over: Parameters<typeof linuxSandbox>[1] = {}): Sandbox {
	return linuxSandbox(undefined, {
		keyFile: env.MINIMAX_API_KEY_FILE?.trim() || undefined,
		...over,
	});
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

/** A scratch copy of the genome under the system temp directory: outside the cell's state and the genome. */
function makeScratch(workspace: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cell-scratch-"));
	fs.chmodSync(dir, 0o700);
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
		if (validatePatch(fs.readFileSync(f, "utf-8")).ok && gitApply(scratch, f, true))
			gitApply(scratch, f, false);
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
	if (!m.baseUrl.startsWith("https://")) throw new PreCallError("the model endpoint must be https");
	const f = m.fetchImpl ?? ((u, i) => fetch(u, i));
	// From here a request may have been charged: a failure costs the usage it reports, else max_tokens.
	let res: Response;
	try {
		res = await f(`${m.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
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
	} catch {
		throw new CallError("the model call failed before an answer", o.maxTokens);
	}
	if (!res.ok) throw new CallError(`the model endpoint answered ${res.status}`, o.maxTokens);
	let j: { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
	try {
		j = (await res.json()) as typeof j;
	} catch {
		throw new CallError("the model answer was not JSON", o.maxTokens);
	}
	const t = j.usage?.total_tokens;
	const usage = typeof t === "number" && Number.isFinite(t) ? t : null;
	const text = j.choices?.[0]?.message?.content;
	if (typeof text !== "string" || text === "")
		throw new CallError("the model answered with no text", usage ?? o.maxTokens);
	return { text, tokens: usage };
}

/** The key, kept out of the process environment. MINIMAX_API_KEY_FILE is read at the call; else the key taken from the environment. */
function takeKey(env: Env): () => string | null {
	const held = env.MINIMAX_API_KEY?.trim() || null;
	Reflect.deleteProperty(env, "MINIMAX_API_KEY");
	const file = env.MINIMAX_API_KEY_FILE?.trim();
	return () => {
		if (file) {
			try {
				const v = fs.readFileSync(file, "utf-8").trim();
				if (v) return v;
			} catch {}
		}
		return held;
	};
}

async function defaultComplete(
	env: Env,
	getKey: () => string | null,
	fetchImpl?: RoundDeps["fetchImpl"],
): Promise<Complete> {
	const { resolveProviderBaseUrl } = await import("../providers/key-resolver");
	const f = fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
	return async (p, o) => {
		// Resolved here, for this call only.
		const key = getKey();
		const baseUrl = resolveProviderBaseUrl("minimax");
		if (!baseUrl || !key)
			throw new PreCallError(
				"no MiniMax key: MINIMAX_API_KEY or MINIMAX_API_KEY_FILE on this cell",
			);
		let model = env.SELFIMPROVE_MODEL?.trim();
		if (!model) {
			const res = await f(`${baseUrl.replace(/\/+$/, "")}/models`, {
				headers: { authorization: `Bearer ${key}` },
				redirect: "error",
				signal: AbortSignal.timeout(30_000),
			});
			const list = (await res.json()) as { data?: Array<{ id?: string }> };
			model = list.data?.find((x) => typeof x.id === "string")?.id;
			if (!model) throw new PreCallError("the model endpoint listed no models");
		}
		return minimaxComplete(p, o, { baseUrl, key, model, fetchImpl: f });
	};
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

	// The key leaves the process environment now; it is read again only for the model call.
	const getKey = takeKey(env);

	// Model-written code runs in a sandbox, or not at all.
	let sandbox: Sandbox | "off";
	try {
		sandbox = deps.sandbox ?? (env.SELFIMPROVE_UNSANDBOXED === "1" ? "off" : defaultSandbox(env));
	} catch (err) {
		return done("refused", `no sandbox: ${(err as Error).message}`);
	}
	if (sandbox !== "off" && !(await sandbox.probe()))
		return done(
			"refused",
			"no working sandbox on this machine (it needs root, unshare and setpriv); nothing was run. SELFIMPROVE_UNSANDBOXED=1 runs without one, and then the key and the ledger are only as safe as the model",
		);
	// The escape is loud: a warning every round, and every ledger line says so.
	const unsandboxed = sandbox === "off";
	if (unsandboxed) (deps.warn ?? ((l: string) => console.error(l)))(UNSANDBOXED_WARNING);
	const wrap = sandbox === "off" ? (a: string[]) => a : sandbox.wrap;
	const runCheck = deps.runCheck ?? sandboxedRunCheck(wrap);
	const give = (dir: string) => {
		if (sandbox !== "off") sandbox.prepare(dir);
	};

	const workspace = deps.workspace ?? path.resolve(import.meta.dir, "..", "..");
	const cellDir = deps.cellDir ?? path.join(resolveHome(env), ".8gent", "cell");
	const cell = env.CELL_ID.trim();
	const checks = deps.checks ?? loadChecks(workspace);
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
		appendLedger(cellDir, {
			ts: t.toISOString(),
			cell,
			round,
			suite,
			...l,
			...(unsandboxed ? { note: l.note ? `unsandboxed; ${l.note}` : "unsandboxed" } : {}),
		});

	if (spent >= cap) return dormant(lines, t, cellDir, log, `today's ${cap} tokens are spent`);

	const scratch = makeScratch(workspace);
	let tokens = 0;
	try {
		applyKept(scratch, cellDir);
		give(scratch);
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
		const complete = deps.complete ?? (await defaultComplete(env, getKey, deps.fetchImpl));
		let reply: { text: string; tokens: number | null };
		try {
			reply = await complete(prompt, { maxTokens });
		} catch (err) {
			// A call that fails after it may have spent is charged: its usage if it says, else max_tokens.
			if (!(err instanceof PreCallError))
				tokens = err instanceof CallError ? err.tokens : maxTokens;
			throw err;
		}
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
		give(scratch);
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
