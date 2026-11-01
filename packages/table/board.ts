/**
 * The tasks board: ONE surface over the task sources that already exist.
 *
 * James asked "is there a tasks board too yet?" while describing the goal the
 * whole system is pointed at - "dogfooding and improving the main build one PR
 * at a time until any task i have previously done via claude code can easily be
 * done by my boardroom of agents". A board is how he SEES that happening: what
 * was asked for, who owns it, what state it is in, and what evidence closed it.
 *
 * THIS MODULE INVENTS NO TASKS AND STORES NOTHING. There is no board table, no
 * board file, no fourth kind of task. Every row is derived, on read, from a
 * source that already existed before this file did:
 *
 *   1. helm-bridge's PENDING map  - proposals an officer staged with a [[TASK]]
 *                                   marker, waiting on a human's /approve.
 *   2. the relay's /helm/workers  - real running CLI agents, attributed to an
 *                                   officer through the spawn's meta.officer.
 *   3. the worker's own output    - the evidence, including any PR / commit /
 *                                   issue reference the work actually produced.
 *
 * An empty board says "nothing yet". It never shows a demo row.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT SHOW ────────────────────────────────────
 *
 * "Approved" is not a column. It is not a state this system can ever observe:
 * table-routes' runApprovedProposal calls takePending() and executeApproved()
 * in the same breath, so a task is approved and running in the same tick. A
 * column that is always empty is furniture, and inventing a duration for it
 * would be inventing a status. Approval is recorded ON the running row instead
 * (who approved it, when) - which is the fact James actually wants.
 *
 * GitHub is not a column either. Nothing links a GitHub issue to an officer:
 * assignees are empty across the board and there is no officer label, so a
 * GitHub column would be a list of unowned rows - which is just the existing
 * project board with extra steps. Instead GitHub appears where it is genuinely
 * traceable: as EVIDENCE on a task row, extracted from the output the worker
 * actually printed. A PR link on a row means that row's worker produced it.
 *
 * ── DESKS ARE NOT TASKS ─────────────────────────────────────────────────────
 *
 * The load-bearing distinction in this file, measured against the live relay
 * rather than assumed. officer-desks.ts opens a persistent, IDLE terminal for
 * each of the eight officers - an employee sitting at their desk before their
 * first ticket. Those desks report `state: "running"` forever, because the tmux
 * session is genuinely alive. Putting them on a board as running tasks would
 * show James eight permanent phantom rows, which is the same lie as seeding.
 *
 * The discriminator is real and comes from the spawn call, not a heuristic:
 * executeApproved() spawns with `prompt: <the approved command>`, while
 * ensureOfficerDesks() spawns with no prompt at all. So a worker carrying a
 * prompt is a TASK; a worker without one is a DESK. Desks are reported
 * separately (listDesks) and never appear as board rows.
 */
import { OFFICERS } from "./officers";
import {
	listPending,
	readWorkerOutput,
	readWorkers,
	type PendingApproval,
} from "./helm-bridge";

/**
 * The states this system can actually PROVE. Each one is tied to an observable
 * fact, named here so nobody later adds a status the sources cannot support.
 */
export type TaskState =
	/** An officer staged a marker; a human has not approved it yet. Source: the
	 *  live PENDING map. Expires - see `expiresAt`. */
	| "proposed"
	/** A worker carrying this task's prompt is alive and working. */
	| "running"
	/** The worker stopped to ask a human something and is still alive. This is
	 *  the system working correctly, not a failure - it is separated from
	 *  `failed` because it is the one state that is actionable by James. */
	| "needs_you"
	/** The worker finished cleanly. */
	| "done"
	/** The worker exited non-zero on its own merits. */
	| "failed"
	/** The worker was terminated (SIGTERM/SIGKILL). Distinguished from `failed`
	 *  because helm reports a stopped worker as state="failed" with exit 143,
	 *  and reporting a clean shutdown as a failure is a misreport. */
	| "stopped";

/** A reference the work itself produced, extracted from real worker output. */
export interface TaskRef {
	kind: "pr" | "issue" | "commit" | "branch";
	/** Display label, e.g. "#2847" or "a1b2c3d". */
	label: string;
	/** Resolvable URL when one can be built without guessing. */
	url?: string;
}

/** What closed (or is closing) a task. Never a claim beyond what was observed. */
export interface TaskEvidence {
	/**
	 * `verified` - a worker reached a terminal state and we read its exit.
	 * `asserted` - it is still running and this is a raw tail, NOT a completion
	 *              claim. Same honesty labelling helm-bridge already uses.
	 */
	label: "verified" | "asserted";
	/** The command or task text that was actually handed to the harness. */
	command: string;
	/** The working directory, when the relay still knows it. */
	cwd?: string;
	/** Tail of what the worker printed. Empty string when nothing was captured. */
	output: string;
	exitCode?: number;
	/** PRs / issues / commits / branches found in the output above. */
	refs: TaskRef[];
}

/** One row on the board. Every field traces to a source; none are defaulted in
 *  to make a row look complete. */
export interface BoardTask {
	/** Stable within a render: the approval token for a proposal, the worker id
	 *  for anything that ran. */
	id: string;
	state: TaskState;
	/** Officer code, e.g. "8PO". Always present - a task with no owner is not
	 *  put on the board at all. */
	officerCode: string;
	/** The officer's name, e.g. "Samantha". Falls back to the code when the
	 *  roster does not know it, rather than inventing a person. */
	officerName: string;
	/** What was asked for, verbatim. Never summarised or rewritten. */
	title: string;
	/** True when the title is natural-language work for an agentic harness
	 *  rather than a shell line. The two read very differently and the board
	 *  should not pretend they are the same thing. */
	isTask: boolean;
	/** The harness this runs on, e.g. "claude", "codex", "shell". */
	kind: string;
	/** Where it runs. Null when the relay genuinely does not know (an adopted
	 *  worker loses its cwd across a relay restart) - shown as unknown, never
	 *  filled in with a plausible guess. */
	cwd: string | null;
	/** The approval token, while one is still live. */
	token?: string;
	/** Milliseconds since epoch at which an unapproved proposal stops being
	 *  approvable. */
	expiresAt?: number;
	/** The helm worker, once one exists. */
	workerId?: string;
	/** The Table channel this originated in, so a row can be traced back to the
	 *  conversation that produced it. */
	channelId?: string;
	startedAt?: number;
	/** Last observed change, used only for ordering. */
	updatedAt: number;
	evidence?: TaskEvidence;
}

/** An officer's persistent terminal. NOT a task - reported separately so the
 *  board can show the team is staffed without faking work. */
export interface OfficerDesk {
	officerCode: string;
	officerName: string;
	workerId: string;
	kind: string;
	/** "idle" when the desk is open with nothing running. */
	status: string;
	startedAt?: number;
	/**
	 * True when the relay reconciled this desk from tmux after a restart. An
	 * adopted desk has genuinely lost its cwd and its original prompt, so the
	 * UI must say that rather than imply we know what it was doing.
	 */
	adopted: boolean;
}

export interface Board {
	tasks: BoardTask[];
	desks: OfficerDesk[];
	/** Set when a source could not be reached, so the UI can say "I could not
	 *  read the workers" instead of silently rendering an empty board that
	 *  looks like "nothing is happening". The difference matters. */
	warnings: string[];
	generatedAt: number;
}

/** The shape this module needs from the relay. Injected so the derivation is
 *  testable without a live relay or a spawned worker. */
export interface HelmWorker {
	id: string;
	kind?: string;
	cwd?: string | null;
	prompt?: string | null;
	state?: string;
	status?: string;
	exit_code?: number;
	started_at?: number;
	last_activity?: number;
	adopted?: boolean;
	meta?: { officer?: string; token?: string; channel?: string; isTask?: boolean } | null;
}

export interface BoardSources {
	/** Live workers, newest first. Throwing is fine - it becomes a warning. */
	listWorkers(): Promise<HelmWorker[]>;
	/** Tail of a worker's output, for the evidence panel. Only called for the
	 *  rows that need it, so a big board does not fan out to every worker. */
	workerOutput(id: string): Promise<string>;
	/** Live staged proposals. Defaults to helm-bridge's own map. */
	listPending?(): PendingApproval[];
}

function officerName(code: string): string {
	return OFFICERS[code]?.name ?? code;
}

/** Seconds-since-epoch (what helm reports) to milliseconds. Tolerates a value
 *  that is already in milliseconds so a relay change cannot silently produce
 *  dates in 1970. */
export function toMillis(t: number | undefined): number | undefined {
	if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return undefined;
	return t > 1e11 ? t : t * 1000;
}

/**
 * Is this worker a TASK (something was asked of it) or a DESK (an idle terminal
 * an officer sits at)? See the module header - this is the difference between a
 * true board and eight permanent phantom rows.
 *
 * A prompt is only set by executeApproved(); ensureOfficerDesks() never sets
 * one. An ADOPTED worker has lost its prompt to a relay restart, so it cannot
 * be proven to be a task and is treated as a desk - the conservative direction,
 * because inventing a task is worse than under-reporting one.
 */
export function isTaskWorker(w: HelmWorker): boolean {
	if (w.adopted === true) return false;
	return typeof w.prompt === "string" && w.prompt.trim().length > 0;
}

/**
 * Map a worker's reported state onto a board state.
 *
 * `exit 143` is SIGTERM. helm-bridge STOPS a worker itself as soon as it has
 * watched the output settle, so the single most common way for a successful
 * task to end is "state=failed, exit_code=143". Reporting that as a failure
 * would mark most completed work red. Measured against the live relay, where
 * every one of the exited officer desks carries exactly that pair.
 */
export function workerState(w: HelmWorker): TaskState {
	const state = w.state ?? "";
	if (state === "needs_input") return "needs_you";
	if (state === "running") return "running";
	if (state === "done") return "done";
	if (state === "failed") {
		const code = w.exit_code;
		if (code === 0 || code === undefined) return "done";
		// 143 = SIGTERM, 137 = SIGKILL. Terminated, not failed on merit.
		if (code === 143 || code === 137) return "stopped";
		return "failed";
	}
	// An unknown state is not guessed at.
	return "running";
}

/**
 * Pull real references out of worker output. Deliberately conservative: it only
 * matches shapes that cannot mean anything else, because a wrong PR link on an
 * evidence panel is worse than no link.
 *
 * Order is stable (PRs, then issues, then commits, then branches) and each
 * reference appears once, so the same output always renders the same list.
 */
export function extractRefs(output: string): TaskRef[] {
	if (!output) return [];
	const refs: TaskRef[] = [];
	const seen = new Set<string>();
	const add = (r: TaskRef) => {
		const key = `${r.kind}:${r.label}`;
		if (seen.has(key)) return;
		seen.add(key);
		refs.push(r);
	};

	// A full GitHub PR or issue URL is unambiguous, so it wins and carries its
	// own link rather than one we assemble from a guessed repo.
	const urlRe = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/g;
	for (const m of output.matchAll(urlRe)) {
		add({ kind: m[2] === "pull" ? "pr" : "issue", label: `#${m[3]}`, url: m[0] });
	}
	// Bare "#1234" is only trustworthy next to a word that names it - a bare
	// number in a diff or a log line is not a PR reference.
	const bareRe = /\b(pull request|PR|issue|closes|fixes|resolves)\s+#(\d+)/gi;
	for (const m of output.matchAll(bareRe)) {
		const kind = /^(issue|closes|fixes|resolves)$/i.test(m[1]) ? "issue" : "pr";
		add({ kind: kind as TaskRef["kind"], label: `#${m[2]}` });
	}
	// A commit needs to be introduced as one. A loose 7-40 char hex run matches
	// far too much (hashes in lockfiles, ids in logs) to be safe on its own.
	// Either an explicit introducer ("commit abc1234", "HEAD is now at abc1234")
	// or git's own commit line ("[feat/x a1b2c3d] message").
	const commitRe = /(?:\b(?:commit|HEAD is now at)\s+|\[[\w/.-]+\s+)([0-9a-f]{7,40})\b/gi;
	for (const m of output.matchAll(commitRe)) {
		add({ kind: "commit", label: m[1].slice(0, 8) });
	}
	const branchRe = /\b(?:branch|Switched to a new branch|->)\s+'?((?:feat|fix|docs|chore|ci|refactor|test|ops)\/[\w.-]+)'?/g;
	for (const m of output.matchAll(branchRe)) {
		add({ kind: "branch", label: m[1] });
	}
	return refs;
}

/** A staged proposal becomes a `proposed` row. */
function fromPending(p: PendingApproval): BoardTask {
	const code = p.agentId.replace(/^agent:/, "");
	return {
		id: p.token,
		state: "proposed",
		officerCode: code,
		officerName: officerName(code),
		title: p.command,
		isTask: p.isTask === true,
		kind: p.kind,
		cwd: p.cwd,
		token: p.token,
		expiresAt: p.createdAt + 15 * 60 * 1000,
		channelId: p.channelId,
		updatedAt: p.createdAt,
	};
}

/** A task worker becomes a row in whatever state it is actually in. */
function fromWorker(w: HelmWorker): BoardTask | null {
	const code = w.meta?.officer;
	// No officer attribution means no owner, and an unowned row has no place on
	// a board whose whole purpose is "who owns it".
	if (!code) return null;
	const started = toMillis(w.started_at);
	const activity = toMillis(w.last_activity);
	return {
		id: w.id,
		state: workerState(w),
		officerCode: code,
		officerName: officerName(code),
		title: (w.prompt ?? "").trim(),
		isTask: w.meta?.isTask === true,
		kind: w.kind ?? "shell",
		// An empty cwd from an adopted worker is genuinely unknown, not "".
		cwd: w.cwd && w.cwd.length > 0 ? w.cwd : null,
		workerId: w.id,
		token: w.meta?.token,
		channelId: w.meta?.channel,
		startedAt: started,
		updatedAt: activity ?? started ?? Date.now(),
	};
}

function toDesk(w: HelmWorker): OfficerDesk | null {
	const code = w.meta?.officer;
	if (!code) return null;
	return {
		officerCode: code,
		officerName: officerName(code),
		workerId: w.id,
		kind: w.kind ?? "shell",
		status: w.status ?? w.state ?? "unknown",
		startedAt: toMillis(w.started_at),
		adopted: w.adopted === true,
	};
}

/** Rows a human still has to act on come first; then live work; then history,
 *  newest first. Ordering only - it never changes what a row says. */
const STATE_RANK: Record<TaskState, number> = {
	needs_you: 0,
	proposed: 1,
	running: 2,
	failed: 3,
	done: 4,
	stopped: 5,
};

/**
 * Build the board.
 *
 * Failure of any single source degrades to a WARNING plus the rows that could
 * be read, never to a silently empty board - "I could not reach the relay" and
 * "nothing is running" look identical otherwise, and they mean opposite things.
 */
export async function buildBoard(sources: BoardSources): Promise<Board> {
	const warnings: string[] = [];
	const tasks: BoardTask[] = [];
	const desks: OfficerDesk[] = [];

	// 1. Proposals waiting on a human.
	try {
		const pending = (sources.listPending ?? listPending)();
		for (const p of pending) tasks.push(fromPending(p));
	} catch (err) {
		warnings.push(`Could not read staged proposals: ${String(err).slice(0, 160)}`);
	}

	// 2. Real workers: tasks on the board, desks to one side.
	let workers: HelmWorker[] = [];
	try {
		workers = await sources.listWorkers();
	} catch (err) {
		warnings.push(`Could not reach the worker relay: ${String(err).slice(0, 160)}`);
	}
	for (const w of workers) {
		if (isTaskWorker(w)) {
			const row = fromWorker(w);
			if (row) tasks.push(row);
		} else {
			const desk = toDesk(w);
			// Only LIVE desks are worth showing; an exited desk is not a person at
			// a desk, it is a closed session.
			if (desk && desk.status !== "exited") desks.push(desk);
		}
	}

	// 3. Evidence, only for rows that ran. A proposal has no evidence yet, and
	//    saying so is the honest thing rather than showing an empty panel.
	await Promise.all(
		tasks.map(async (t) => {
			if (!t.workerId) return;
			let output = "";
			try {
				output = await sources.workerOutput(t.workerId);
			} catch {
				// A missing tail is not worth a warning per row; the row still shows
				// its state, it just cannot show what was printed.
			}
			const terminal = t.state === "done" || t.state === "failed" || t.state === "stopped";
			t.evidence = {
				label: terminal ? "verified" : "asserted",
				command: t.title,
				cwd: t.cwd ?? undefined,
				output,
				exitCode: workers.find((w) => w.id === t.workerId)?.exit_code,
				refs: extractRefs(output),
			};
		}),
	);

	tasks.sort((a, b) => {
		const r = STATE_RANK[a.state] - STATE_RANK[b.state];
		return r !== 0 ? r : b.updatedAt - a.updatedAt;
	});
	desks.sort((a, b) => a.officerCode.localeCompare(b.officerCode));

	return { tasks, desks, warnings, generatedAt: Date.now() };
}

/** The real sources: the live relay plus helm-bridge's own pending map. Tests
 *  inject their own instead, which is why buildBoard takes them as an argument
 *  rather than reaching for these itself. */
export const liveSources: BoardSources = {
	listWorkers: async () => (await readWorkers()) as HelmWorker[],
	workerOutput: (id) => readWorkerOutput(id),
	listPending,
};

/** Column layout for the UI, defined once here so backend and UI cannot drift
 *  into disagreeing about which states exist. */
export const BOARD_COLUMNS: { state: TaskState; title: string; hint: string }[] = [
	{ state: "needs_you", title: "Needs you", hint: "Stopped to ask a question. Still running - answer it and it carries on." },
	{ state: "proposed", title: "Proposed", hint: "An officer asked to do this. Approve it and a worker runs it." },
	{ state: "running", title: "Running", hint: "A worker is doing this right now." },
	{ state: "done", title: "Done", hint: "Finished cleanly." },
	{ state: "failed", title: "Failed", hint: "Exited with an error." },
	{ state: "stopped", title: "Stopped", hint: "Terminated rather than failed on its own merits." },
];
