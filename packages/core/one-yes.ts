/**
 * One shared resolver for every one-yes prompt (#4919, F10).
 *
 * Principle: unattended means no. A prompt that hands over a capability (install,
 * allow, run) is answered only by a person who is there. The answer is "no" when:
 *   - nobody can answer (no TTY, CI, EIGHT_UNATTENDED, a daemon or headless run),
 *   - nobody answers within the wait (default 60 s, EIGHT_ONE_YES_TIMEOUT_MS), or
 *   - the input ends.
 * Only a typed y or yes inside the window is a yes. A bare Enter is a no. Nothing is
 * remembered between prompts. Every no that nobody chose is logged in one line and
 * recorded in the denial ledger (<home>/.8gent/one-yes-denials.jsonl).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { userInfo } from "node:os";
import * as path from "node:path";
import { resolveHome } from "./home";

type Env = Record<string, string | undefined>;

export const ONE_YES_DEFAULT_TIMEOUT_MS = 60_000;

export type OneYesReason =
	| "yes"
	| "no"
	| "empty-answer"
	| "timeout"
	| "closed-input"
	| "no-tty"
	| "unattended-env";

/** Reasons that mean nobody could answer: the caller may skip its prompt flow. */
export const isUnattendedReason = (r: OneYesReason): boolean =>
	r === "no-tty" || r === "unattended-env";

export interface OneYesResult {
	answer: boolean;
	reason: OneYesReason;
}

export interface OneYesOptions {
	/** Names the call site ("desktop-type", "judge-install"). Only this is ever logged or recorded, never prompt text. */
	label: string;
	env?: Env;
	input?: NodeJS.ReadableStream & { isTTY?: boolean };
	output?: NodeJS.WritableStream & { isTTY?: boolean };
	/** Wait for a person, in ms. Default 60 s. */
	timeoutMs?: number;
	/** Treat a non-TTY input as attended (a piped test input). Never set in product code. */
	assumeAttended?: boolean;
	/** One line, when a prompt resolved to no because nobody answered. */
	log?: (line: string) => void;
	/** Denial ledger sink. Default: <home>/.8gent/one-yes-denials.jsonl. */
	record?: (entry: Record<string, unknown>) => void;
	now?: () => Date;
}

const isSet = (v: string | undefined) => !!v && v !== "0" && v.toLowerCase() !== "false";

// ---------------- Owned terminal sessions: nobody is present ----------------
//
// An 8gent that another 8gent opened in a terminal session (/term, term_spawn) has no person
// at its keyboard: the keystrokes come from the model that opened it. An environment variable
// cannot mark that, because the model types into a shell and `env -u`, `unset` or a
// `HOME=...` prefix removes or redirects it. So the child looks at its own parents: if one is
// a tmux server started on a socket under ~/.8gent/term (the app's private servers, see
// terminal-tab/tmux-session.ts), it is inside an owned session. A shell cannot change who its
// parents are. Where a platform's tmux does not show the socket path in its command line, the
// server's pid is read from the run's owner record, which the spawner writes.

/** The walk up from this process stops here, so a broken table cannot loop. */
export const OWNED_PANE_MAX_HOPS = 32;

export interface ProcessRow {
	ppid: number;
	command: string;
}
export type ProcessLookup = (pid: number) => ProcessRow | undefined;

const psLookup: ProcessLookup = (pid) => {
	try {
		const r = spawnSync("ps", ["-ww", "-o", "ppid=,command=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2000,
		});
		if (r.status !== 0) return undefined;
		const m = /^\s*(\d+)\s+(\S[\s\S]*)$/.exec(r.stdout.trim());
		return m ? { ppid: Number(m[1]), command: m[2] } : undefined;
	} catch {
		return undefined;
	}
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The directories the app's private tmux sockets live in: the account's home, and the HOME in use. */
function termDirs(env: Env): string[] {
	const homes = new Set<string>();
	try {
		homes.add(userInfo().homedir);
	} catch {
		// no passwd entry: the env home below still applies
	}
	homes.add(resolveHome(env));
	return [...homes].filter(Boolean).map((h) => path.join(h, ".8gent", "term"));
}

/** Server pids the spawner recorded: line 2 of each <run>.pid owner record. */
function recordedServerPids(dirs: string[]): Set<number> {
	const out = new Set<number>();
	for (const dir of dirs) {
		let names: string[] = [];
		try {
			names = fs.readdirSync(dir).filter((n) => n.endsWith(".pid"));
		} catch {
			continue;
		}
		for (const n of names) {
			try {
				const n2 = Number(fs.readFileSync(path.join(dir, n), "utf8").split("\n")[1]);
				if (Number.isInteger(n2) && n2 > 1) out.add(n2);
			} catch {
				// unreadable record: skip it
			}
		}
	}
	return out;
}

/**
 * True when a parent process of `pid` is a tmux server of the app's private run (see above).
 * Walks at most OWNED_PANE_MAX_HOPS parents. A process table that cannot be read answers false.
 */
export function inOwnedPane(
	opts: { pid?: number; env?: Env; lookup?: ProcessLookup; dirs?: string[] } = {},
): boolean {
	const env = opts.env ?? process.env;
	const lookup = opts.lookup ?? psLookup;
	const dirs = opts.dirs ?? termDirs(env);
	const socketArg = new RegExp(`(?:-S\\s*|\\()(?:${dirs.map(escapeRe).join("|")})/`);
	let servers: Set<number> | undefined;
	const start = opts.pid ?? process.pid;
	let pid = start;
	let row = lookup(pid);
	for (let hop = 0; hop < OWNED_PANE_MAX_HOPS && row; hop++) {
		const exe = path.basename(row.command.split(/\s+/)[0] ?? "");
		if (pid !== start && (exe === "tmux" || row.command.startsWith("tmux:"))) {
			if (socketArg.test(row.command)) return true;
			servers ??= recordedServerPids(dirs);
			if (servers.has(pid)) return true;
		}
		if (row.ppid <= 1) return false;
		pid = row.ppid;
		row = lookup(pid);
	}
	return false;
}

let ancestryCache: boolean | undefined;
/** The answer for this process, read once: a child's parents do not change what it was started in. */
export function ownedPaneAncestry(): boolean {
	ancestryCache ??= inOwnedPane();
	return ancestryCache;
}

/**
 * Nobody is present, whatever any setting says: EIGHT_UNATTENDED is set, or the process runs
 * inside an owned terminal session. This outranks EIGHT_HEADLESS_APPROVE, auto-approve and
 * Infinite mode. `ancestry` is for tests; product code leaves it to the process's own parents.
 */
export function forcedUnattended(
	env: Env = process.env,
	ancestry: boolean = ownedPaneAncestry(),
): boolean {
	return isSet(env.EIGHT_UNATTENDED) || ancestry;
}

/** CI, EIGHT_UNATTENDED, an owned terminal session, EIGHT_HEADLESS, or no terminal: nobody can answer. */
export function unattended(
	env: Env = process.env,
	stdin: { isTTY?: boolean } = process.stdin,
	stdout: { isTTY?: boolean } = process.stdout,
): boolean {
	return (
		isSet(env.CI) ||
		forcedUnattended(env) ||
		isSet(env.EIGHT_HEADLESS) ||
		!stdin.isTTY ||
		!stdout.isTTY
	);
}

export function oneYesTimeoutMs(env: Env = process.env): number {
	const n = Number(env.EIGHT_ONE_YES_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? n : ONE_YES_DEFAULT_TIMEOUT_MS;
}

function defaultRecord(env: Env): (entry: Record<string, unknown>) => void {
	return (entry) => {
		try {
			const dir = path.join(resolveHome(env), ".8gent");
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fs.appendFileSync(path.join(dir, "one-yes-denials.jsonl"), `${JSON.stringify(entry)}\n`, {
				mode: 0o600,
			});
		} catch {
			// The ledger is best effort; the answer is already no.
		}
	};
}

/**
 * For callers that show the question themselves (the TUI prints it in its message list and
 * resolves on the next typed line). True means nobody is attending: the denial is logged and
 * recorded exactly as askOneYesDetailed does, and the caller must not show or wait on the
 * question. The env flags apply here because the TUI answers on the process terminal.
 */
export function refuseIfUnattended(
	label: string,
	opts: Pick<OneYesOptions, "env" | "input" | "output" | "log" | "record" | "now"> = {},
): boolean {
	const env = opts.env ?? process.env;
	const input = opts.input ?? process.stdin;
	const output = opts.output ?? process.stdout;
	if (!unattended(env, input, output)) return false;
	const reason: OneYesReason =
		isSet(env.CI) || forcedUnattended(env) || isSet(env.EIGHT_HEADLESS)
			? "unattended-env"
			: "no-tty";
	const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const record = opts.record ?? defaultRecord(env);
	const now = opts.now ?? (() => new Date());
	log(`[one-yes] resolved to no (${reason}): nobody answered the ${label} prompt`);
	record({ at: now().toISOString(), event: "one-yes-resolved-no", reason, label });
	return true;
}

/**
 * Ask a one-yes question. Never throws, never waits past the bound, never answers yes
 * unless a person typed y or yes in time.
 */
export async function askOneYesDetailed(
	question: string,
	opts: OneYesOptions,
): Promise<OneYesResult> {
	const env = opts.env ?? process.env;
	const input = opts.input ?? process.stdin;
	const output = opts.output ?? process.stdout;
	const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const record = opts.record ?? defaultRecord(env);
	const now = opts.now ?? (() => new Date());

	// Only the label, the reason and the time are written. The prompt can carry typed text,
	// commands or tokens (#4057), so it never reaches the log or the ledger.
	const deny = (reason: Exclude<OneYesReason, "yes" | "no">): OneYesResult => {
		log(`[one-yes] resolved to no (${reason}): nobody answered the ${opts.label} prompt`);
		record({ at: now().toISOString(), event: "one-yes-resolved-no", reason, label: opts.label });
		return { answer: false, reason };
	};

	// CI, EIGHT_UNATTENDED and EIGHT_HEADLESS speak for the process terminal. A caller that
	// hands in its own stream (an embedded caller, a test harness) is the answer channel, so
	// the env flags apply only to the default process.stdin path.
	const ownStream = opts.input !== undefined && opts.input !== process.stdin;
	const envOff = isSet(env.CI) || isSet(env.EIGHT_UNATTENDED) || isSet(env.EIGHT_HEADLESS);
	if (envOff && !ownStream) return deny("unattended-env");
	// Where the process runs is not a stream a caller hands in: an owned session is nobody present.
	if (ownedPaneAncestry()) return deny("unattended-env");
	// A person answers on the input; a piped output (a log, a redirect) does not make it unattended.
	if (!opts.assumeAttended && !input.isTTY) return deny("no-tty");

	const { createInterface } = await import("node:readline");
	let rl: ReturnType<typeof createInterface> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		rl = createInterface({ input, output, terminal: false });
		const r = rl;
		const got = await new Promise<string | null | undefined>((resolve) => {
			r.once("line", (l) => resolve(l));
			r.once("close", () => resolve(null));
			timer = setTimeout(() => resolve(undefined), opts.timeoutMs ?? oneYesTimeoutMs(env));
			output.write(`${question} `);
		});
		if (got === undefined) {
			output.write("\n");
			return deny("timeout");
		}
		if (got === null) return deny("closed-input");
		if (got.trim() === "") return deny("empty-answer");
		const yes = /^\s*y(es)?\s*$/i.test(got);
		return { answer: yes, reason: yes ? "yes" : "no" };
	} catch {
		return deny("closed-input");
	} finally {
		if (timer) clearTimeout(timer);
		rl?.close();
	}
}

/** true only for a typed y or yes inside the window. */
export async function askOneYes(question: string, opts: OneYesOptions): Promise<boolean> {
	return (await askOneYesDetailed(question, opts)).answer;
}
