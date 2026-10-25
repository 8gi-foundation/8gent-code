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

import * as fs from "node:fs";
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

/** CI, EIGHT_UNATTENDED, EIGHT_HEADLESS, or no terminal: nobody can answer. */
export function unattended(
	env: Env = process.env,
	stdin: { isTTY?: boolean } = process.stdin,
	stdout: { isTTY?: boolean } = process.stdout,
): boolean {
	return (
		isSet(env.CI) ||
		isSet(env.EIGHT_UNATTENDED) ||
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
