/**
 * 8gent - Agentic Honesty gate (Law 1: no fabricated completion).
 *
 * The agent MUST NOT claim an action happened ("created / successful / done /
 * committed") unless a tool actually ran this turn and returned success. This
 * module gates the final response on the turn's tool ledger:
 *
 *   - If the turn made at least one SUCCESSFUL action-tool call, the reply
 *     passes through untouched.
 *   - If every action-tool call FAILED and the reply still claims completion,
 *     the reply is replaced with an honest, actionable failure report built
 *     from the real tool errors.
 *   - If NO action tool ran at all and the reply claims a concrete completed
 *     action (a file/commit that "was created"), the reply is replaced with an
 *     honest "nothing actually ran" note.
 *
 * Pure functions, no I/O - the caller (packages/eight/agent.ts) owns the
 * ledger and applies the gate on both the native tool loop and the text-tool
 * loop. See issue #2747 and the AgenticHonesty skill.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { isTestRun } from "./test-claim-gate";

/** One tool call made during the current turn. */
export interface ToolLedgerEntry {
	name: string;
	args?: Record<string, unknown>;
	success: boolean;
	/** Tool output (or error string) - used to build the honest failure report. */
	result?: string;
}

/**
 * Tools whose success a completion claim can legitimately rest on. Read-only
 * tools (read_file, list_files, web_search, ...) never justify "I created X".
 */
export const ACTION_TOOLS: ReadonlySet<string> = new Set([
	"write_file",
	"edit_file",
	"delete_file",
	"run_command",
	"git_add",
	"git_commit",
	"git_push",
	"make_pdf",
	"make_docx",
	"make_xlsx",
	"make_pptx",
	"speak",
	"render_video_deck",
	"run_computer_task",
	"desktop_click",
	"desktop_type",
	"desktop_press",
	"desktop_drag",
]);

/**
 * Detect the executor's string-shaped error results (it returns error STRINGS
 * rather than throwing for most failure modes). Mirrors the check in
 * agent.ts's tool wrappers so both paths classify results identically.
 */
export function isErrorToolResult(result: string): boolean {
	const head = result.trimStart();
	// Rule: "err:" at the start (after whitespace) in any case (ERR:, Err:, err:) is a failure; the colon must directly follow the three letters.
	if (/^err:/i.test(head)) return true;
	return /^(\[[A-Z_ ]*(BLOCKED|DENIED|ERROR)\]|Error:|Error running tool|Unknown tool:|Path blocked by path-guard|Path traversal blocked)/.test(
		head,
	);
}

// A "fileish" object: the artifacts a completion claim is usually about.
const FILEISH =
	String.raw`(?:file|files|folder|directory|dir|repo|repository|branch|commit|document|script|` +
	String.raw`\S+\.(?:txt|md|ts|tsx|js|jsx|py|json|swift|sh|zsh|yml|yaml|toml|html|css|pdf|csv))`;

/**
 * Success-claim detectors. Each pattern requires either explicit success
 * phrasing ("creation successful", "successfully created", "has been
 * created") or an action verb tied to a fileish object ("created the file",
 * "file created at ..."), so ordinary informational prose ("here is how files
 * are created on Unix") does not trip the gate.
 */
const SUCCESS_CLAIM_PATTERNS: RegExp[] = [
	/\b(?:creation|write|update|deletion|removal|commit|push|operation|task) (?:was |is )?successful\b/i,
	/\bsuccessfully (?:created|wrote|written|saved|updated|deleted|removed|committed|pushed|initiated|completed)\b/i,
	/\bhas been (?:successfully )?(?:created|written|saved|updated|deleted|removed|committed|pushed)\b/i,
	/\bhave been (?:successfully )?(?:created|written|saved|updated|deleted|removed|committed|pushed)\b/i,
	new RegExp(
		String.raw`\b(?:i|we)(?:'ve| have)? (?:just )?(?:created|wrote|written|saved|updated|deleted|committed|pushed)\b[^\n]{0,80}\b${FILEISH}\b`,
		"i",
	),
	new RegExp(
		String.raw`\b${FILEISH} (?:was |is )?(?:created|written|saved) (?:at|in|with|to)\b`,
		"i",
	),
	new RegExp(String.raw`\b(?:created|wrote|saved) (?:the |a |an )?(?:new )?${FILEISH}\b`, "i"),
	new RegExp(
		String.raw`\b${FILEISH}\b[^\n]{0,60}\b(?:created|written|saved|committed|pushed) successfully\b`,
		"i",
	),
];

/** True when the reply claims a concrete completed action. */
export function claimsCompletion(content: string): boolean {
	if (!content) return false;
	return SUCCESS_CLAIM_PATTERNS.some((p) => p.test(content));
}

/** First words of the failure reply below. Exported so no caller copies the literal. */
export const HONEST_FAILURE_PREFIX = "I could not complete that action.";

/**
 * True when a failed tool result is the harness's own permission or sandbox refusal,
 * not an outage or a bug. Bare "refused" is not a denial: "connection refused" is an outage.
 */
export function isDenialResult(result: string | undefined): boolean {
	return /\b(BLOCKED|DENIED)\b|permission denied|outside working directory|path traversal|path blocked/i.test(
		result ?? "",
	);
}

/** Reply for a success claim made after every action tool FAILED. */
export function buildHonestFailureReply(
	failed: ToolLedgerEntry[],
	workingDirectory?: string,
): string {
	const lines = failed.slice(-5).map((e) => {
		const err = (e.result ?? "unknown error").replace(/\s+/g, " ").trim().slice(0, 220);
		const argHint =
			e.args && typeof (e.args as { path?: unknown }).path === "string"
				? ` (path: ${(e.args as { path: string }).path})`
				: "";
		return `- ${e.name}${argHint} failed: ${err}`;
	});
	const sandboxHit = failed.some((e) =>
		/outside working directory|path traversal|path blocked/i.test(e.result ?? ""),
	);
	const sandboxNote =
		sandboxHit && workingDirectory
			? `\n\nI can only write inside ${workingDirectory}. Give me a path inside that directory (or change my working directory) and I will retry for real.`
			: "";
	return `${HONEST_FAILURE_PREFIX}\n\n${lines.join("\n")}\n\nNothing was written or changed on disk this turn.${sandboxNote}`;
}

/** Reply for a completion claim made with NO action tool run at all. */
export function buildNoActionReply(): string {
	return (
		"I have not actually done that yet - no tool ran this turn, so nothing changed " +
		"on disk. To do it for real I need to execute the corresponding tool (for " +
		"example write_file). Ask me to proceed and I will run it."
	);
}

// ── Action claims (break found by the daily-driver pilot) ─────────────────────
//
// Law 1 above passes a reply when ANY action tool succeeded, and its patterns
// only know "successfully committed", "has been committed" and "I committed
// <file>". So "Committed both files with the message add sub", sent with no
// tool call at all, matched nothing and reached the user as fact (qwen3.8:27b,
// git log still showed only the init commit). A claim of one specific action
// has to be backed by a successful call of that action, not by any call.

type ActionClaimKind = "commit" | "push" | "tests";

interface ActionClaim {
	kind: ActionClaimKind;
	/** Past-tense report of the action. */
	says: RegExp;
	/** The turn's ledger and repo state show this action happened. */
	backed: (ledger: readonly ToolLedgerEntry[], repo?: RepoDelta) => boolean;
	/** Shown to the user under the reply. */
	note: (ledger: readonly ToolLedgerEntry[], repo?: RepoDelta) => string;
}

const exitedNonZero = (e: ToolLedgerEntry) => /^Exit code (?!0\b)/.test(e.result ?? "");

// ── Repo state ───────────────────────────────────────────────────────────────
//
// When the repository can be read, whether a commit or push HAPPENED is read
// from it, not from output text or from how the shell line is parsed (eight
// rounds of review found a new trick each time: pipes, flags, brace expansion,
// grep file options, aliases, scripts, variables).
// - Commit: in the turn's own directory the HEAD reflog alone decides.
// - Push: the reflog of the upstream ref pinned at turn start decides.
// - With a readable repository, command text only adds other directories to
//   check (`-C <dir>`, a leading `cd <dir>`).
// Two fallbacks still rest on the tool ledger, because there is no reflog to
// read: with no repository state at all, a `git_commit` call, or a plain,
// unpiped, unchained shell `git commit` that exited 0 (see plainGit), backs a
// commit claim; and with no upstream at the start or end of the turn, a
// `git_push` call or the same kind of plain `git push` backs a push claim.

/** What the repo looked like at one instant. All local reads; nothing touches the network. */
export interface RepoSnapshot {
	/** Directory the snapshot was read from. */
	cwd: string;
	/** Epoch ms when it was taken: the start of the turn, for other directories' reflogs. */
	since: number;
	head: string;
	/** `@{u}`, when the branch tracks one. */
	upstream?: string;
	/** `@{u}` as a ref NAME (refs/remotes/origin/feat2), pinned so a later checkout cannot swap it. */
	upstreamRef?: string;
	/** HEAD is an ancestor of (or equal to) `@{u}`. */
	headInUpstream: boolean;
	/** Entries in the HEAD reflog now, so entries beyond it are this turn's. */
	headReflog: number;
	/** Entries in the pinned upstream ref's reflog. */
	upstreamReflog: number;
}

/** The repo at the start of the turn and at its end. `null` = could not be read (no repo). */
export interface RepoDelta {
	before: RepoSnapshot | null;
	after: RepoSnapshot | null;
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		}).trim();
	} catch {
		return undefined;
	}
}

interface ReflogEntry {
	/** The sha the ref moved to. */
	sha: string;
	/** "commit: msg", "commit (amend): msg", "update by push", "pull: ...", "checkout: ...". */
	subject: string;
	/** Epoch seconds. */
	ts: number;
}

/** A ref's reflog, newest first. Undefined when git cannot read it. Local only. */
function readReflog(cwd: string, ref: string): ReflogEntry[] | undefined {
	const out = git(cwd, ["reflog", "show", "--date=unix", "--format=%H%x09%gs%x09%gd", ref, "--"]);
	if (out === undefined) return undefined;
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha = "", subject = "", sel = ""] = line.split("\t");
			return { sha, subject, ts: Number(/@\{(\d+)\}$/.exec(sel)?.[1] ?? 0) };
		});
}

/** `git rev-parse`, `merge-base` and `reflog show` only. Null outside a repo or before the first commit. */
export function readRepoSnapshot(cwd: string): RepoSnapshot | null {
	const since = Date.now();
	const head = git(cwd, ["rev-parse", "HEAD"]);
	if (!head) return null;
	const upstream = git(cwd, ["rev-parse", "@{u}"]);
	const upstreamRef = upstream
		? git(cwd, ["rev-parse", "--symbolic-full-name", "@{u}"])
		: undefined;
	const headInUpstream =
		upstream !== undefined &&
		git(cwd, ["merge-base", "--is-ancestor", "HEAD", "@{u}"]) !== undefined;
	return {
		cwd,
		since,
		head,
		upstream,
		upstreamRef,
		headInUpstream,
		headReflog: readReflog(cwd, "HEAD")?.length ?? 0,
		upstreamReflog: upstreamRef ? (readReflog(cwd, upstreamRef)?.length ?? 0) : 0,
	};
}

const COMMIT_CMD = /\bgit(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+commit\b/;
const PUSH_CMD = /\bgit(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+push\b/;

/**
 * With no readable repo state: only a plain, unpiped, unchained `git commit` or
 * `git push` that exited 0 counts. Anything the shell could rewrite (quotes outside
 * the message, `$`, braces, pipes, chains, redirects) or that asks for a dry run or
 * help is "could not confirm".
 */
function plainGit(e: ToolLedgerEntry, sub: "commit" | "push"): boolean {
	const command = e.args?.command;
	if (e.name !== "run_command" || typeof command !== "string") return false;
	const text = command
		.replace(/\\\n/g, "")
		.replace(/(?:-m|--message)(?:\s+|=)?(?:"[^"]*"|'[^']*'|\S+)/, " ");
	if (/["'\\$`{}()*?;&|<>!#~\n]/.test(text)) return false;
	if (/(?:^|\s)(?:--d\S*|--h\S*|-[A-Za-z]*[nh][A-Za-z]*)(?:\s|$)/.test(text)) return false;
	return new RegExp(`^\\s*git(?:\\s+-C\\s+\\S+)?\\s+${sub}\\b`).test(text);
}

const ran = (e: ToolLedgerEntry) => e.success && !exitedNonZero(e);

// ── Where the command ran ────────────────────────────────────────────────────
//
// `git -C <dir> commit` and a leading `cd <dir> && git commit` act on another repository.
// Only that repository can say whether the commit or push happened. Any other form
// (subshell, pushd, --git-dir, GIT_DIR, bash -c) is read in the turn's own directory
// and, finding nothing, reads "could not confirm".

const SHELL_UNSAFE = /["'\\$`~{}*?()<>|&;!#]/;

/** Directories the command may have run in. `unresolved` = a path could not be read. */
function commandDirs(
	command: string,
	cwd: string,
	sub: RegExp,
): { dirs: string[]; unresolved: boolean } {
	const [first = "", ...rest] = command.replace(/\\\n/g, " ").split(/&&|\|\||;|\n/);
	const cd = /^\s*cd\s+(\S+)\s*$/.exec(first);
	let dir = cwd;
	let unresolved = false;
	if (cd) {
		if (SHELL_UNSAFE.test(cd[1] as string)) unresolved = true;
		else dir = resolvePath(cwd, cd[1] as string);
	}
	const dirs: string[] = [];
	for (const seg of cd ? rest : [first, ...rest]) {
		const m = sub.exec(seg);
		if (!m) continue;
		let target = dir;
		for (const c of m[0].matchAll(/(?:^|\s)-C(?:\s+|=)?(\S+)/g)) {
			if (SHELL_UNSAFE.test(c[1] as string)) unresolved = true;
			else target = resolvePath(target, c[1] as string);
		}
		dirs.push(target);
	}
	return { dirs, unresolved };
}

const sameDir = (a: string, b: string) => {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return a === b;
	}
};

/** Proof, or the one reason proof could not be had. Absence of proof is never a finding. */
interface Evidence {
	backed: boolean;
	why?: "directory" | "reflog";
}

/** What one repository said: proof, "unreadable", "empty reflog", or nothing. */
interface Reading {
	backed?: boolean;
	unreadable?: boolean;
	empty?: boolean;
}

const reflogEmpty = (dir: string) => (readReflog(dir, "HEAD")?.length ?? 0) === 0;

/**
 * The reflog entries a repo gained this turn: counted from the snapshot in the turn's own
 * directory; elsewhere strictly after the turn's start second and not in the future.
 */
function entriesSince(dir: string, ref: string, repo: RepoDelta): ReflogEntry[] | undefined {
	const all = readReflog(dir, ref);
	const before = repo.before;
	if (!all || !before) return undefined;
	const counted = ref === "HEAD" || ref === before.upstreamRef;
	if (counted && sameDir(dir, before.cwd)) {
		const count = ref === "HEAD" ? before.headReflog : before.upstreamReflog;
		return all.slice(0, Math.max(0, all.length - count));
	}
	const floor = Math.floor(before.since / 1000);
	const now = Math.floor(Date.now() / 1000);
	return all.filter((e) => e.ts > floor && e.ts <= now);
}

function judge(
	ledger: readonly ToolLedgerEntry[],
	repo: RepoDelta,
	sub: RegExp,
	read: (dir: string) => Reading,
): Evidence {
	const cwd = repo.before?.cwd ?? repo.after?.cwd;
	if (!cwd) return { backed: false, why: "directory" };
	const dirs = new Set<string>([cwd]);
	let unconfirmed = false;
	for (const e of ledger) {
		if (
			e.name !== "run_command" ||
			typeof e.args?.command !== "string" ||
			!sub.test(e.args.command)
		)
			continue;
		const found = commandDirs(e.args.command, cwd, sub);
		if (found.unresolved) unconfirmed = true;
		for (const d of found.dirs) dirs.add(d);
	}
	let empty = false;
	for (const dir of dirs) {
		const r = read(dir);
		if (r.backed) return { backed: true };
		if (r.unreadable) unconfirmed = true;
		if (r.empty) empty = true;
	}
	return { backed: false, why: unconfirmed ? "directory" : empty ? "reflog" : undefined };
}

/**
 * Accepted limits, stated so nobody reads "backed" as more than it is:
 * - The reflog says a commit landed on HEAD in this worktree during the turn.
 *   It does not say who made it. A hook, an editor or a background job that
 *   commits here during the turn backs a "Committed." claim. The commit is
 *   real and on HEAD, so the claim is true of the repo, just not of the model.
 * - The reflog is a plain file. A line written by hand, or by
 *   `git update-ref -m "commit: x" HEAD HEAD`, reads as a commit. The gate
 *   catches a model that says more than it did; it is not a defence against
 *   one that forges the repository's own record.
 * - A sibling worktree has its own HEAD reflog, so a commit there backs nothing here,
 *   unless the command names that worktree with `-C` or a leading `cd`.
 */
function commitEvidence(ledger: readonly ToolLedgerEntry[], repo: RepoDelta): Evidence {
	return judge(ledger, repo, COMMIT_CMD, (dir) => {
		const entries = entriesSince(dir, "HEAD", repo);
		if (!entries) return { unreadable: true };
		const alive = entries.some(
			(e) =>
				e.subject.startsWith("commit") &&
				git(dir, ["merge-base", "--is-ancestor", e.sha, "HEAD"]) !== undefined,
		);
		return alive ? { backed: true } : { empty: reflogEmpty(dir) };
	});
}

function pushEvidence(ledger: readonly ToolLedgerEntry[], repo: RepoDelta): Evidence {
	return judge(ledger, repo, PUSH_CMD, (dir) => {
		// The turn's own directory reads the ref pinned at turn start, never the @{u} of whatever
		// branch a later checkout left. Elsewhere, and when nothing was pinned, the current upstream.
		const pinned =
			repo.before && sameDir(dir, repo.before.cwd) ? repo.before.upstreamRef : undefined;
		const ref = pinned ?? git(dir, ["rev-parse", "--symbolic-full-name", "@{u}"]);
		if (!ref) return { unreadable: true };
		// Remote-tracking reflogs are shared by every worktree: a push only backs this turn
		// when the pushed sha contains this turn's end HEAD.
		const end = git(dir, ["rev-parse", "HEAD"]);
		const pushed = (entriesSince(dir, ref, repo) ?? []).some(
			(e) =>
				e.subject === "update by push" &&
				end !== undefined &&
				git(dir, ["merge-base", "--is-ancestor", end, e.sha]) !== undefined,
		);
		return pushed ? { backed: true } : { empty: reflogEmpty(dir) };
	});
}

function commitBacked(ledger: readonly ToolLedgerEntry[], repo?: RepoDelta): boolean {
	if (repo?.after) return commitEvidence(ledger, repo).backed;
	return ledger.some((e) => ran(e) && (e.name === "git_commit" || plainGit(e, "commit")));
}

function pushBacked(ledger: readonly ToolLedgerEntry[], repo?: RepoDelta): boolean {
	const after = repo?.after;
	if (after?.upstream || repo?.before?.upstreamRef)
		return pushEvidence(ledger, repo as RepoDelta).backed;
	return ledger.some((e) => ran(e) && (e.name === "git_push" || plainGit(e, "push")));
}

const WHY = {
	directory: "the directory it ran in could not be checked",
	reflog: "HEAD has no reflog entries to check",
};
const couldNot = (what: string, why?: keyof typeof WHY) =>
	`Could not confirm ${what}${why ? `: ${WHY[why]}` : ""}.`;

const UNREADABLE =
	"the repository state could not be read, so only a plain successful command counts";

const ACTION_CLAIMS: readonly ActionClaim[] = [
	{
		kind: "commit",
		says: /\b(?:committed|(?:created|made)\s+(?:the\s+|a\s+|that\s+)?commit|commit\s+(?:is\s+|was\s+)?(?:created|made|done|complete))\b/i,
		backed: commitBacked,
		note: (ledger, repo) => {
			if (!repo?.after) return `Could not confirm a commit: ${UNREADABLE}.`;
			return couldNot("a commit", commitEvidence(ledger, repo).why);
		},
	},
	{
		kind: "push",
		says: /\b(?:pushed|push\s+(?:is\s+|was\s+)?(?:done|complete|succeeded))\b/i,
		backed: pushBacked,
		note: (ledger, repo) => {
			if (!repo?.after?.upstream && !repo?.before?.upstreamRef)
				return `Could not confirm a push: ${UNREADABLE}.`;
			const { why } = pushEvidence(ledger, repo);
			return couldNot(why ? "a push" : "a push to the tracked branch", why);
		},
	},
	{
		kind: "tests",
		says: /\b(?:ran|executed)\s+(?:the\s+|all\s+|your\s+|our\s+)?(?:unit\s+|full\s+)?(?:tests?|test\s+suite)\b/i,
		backed: (ledger) => ledger.some((e) => e.success && isTestRun(e)),
		note: () => "Could not confirm a test run.",
	},
];

// ── Reading a reply ──────────────────────────────────────────────────────────

/** Clauses of a reply: lines, sentence ends, commas, semicolons, "but". Code blocks and quotes dropped. */
function replyClauses(text: string): string[] {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.split(/\n+/)
		.filter((line) => !/^\s*>/.test(line))
		.flatMap((line) => line.split(/(?<=[.!?:])\s+/))
		.filter((sentence) => !/\?\s*$/.test(sentence))
		.flatMap((sentence) => sentence.split(/\s*[,;]\s*|\s+(?:but|however|although|though)\s+/i))
		.map((c) => c.trim())
		.filter(Boolean);
}

// A negation, a modal or a subordinator within a few words before the verb means the clause
// is not reporting the action ("did not push", "ready to be committed", "if I committed").
const GOVERNS =
	/\b(?:not|never|no|nothing|cannot|unable|failed|without|yet|won't|can't|didn't|couldn't|wasn't|haven't|hasn't|hadn't|isn't|aren't|don't|will|would|should|could|can|may|might|must|if|once|until|unless|whether|need|needs|want|wants|please|ready|let|to|before|after|when)\b|n't\b/i;
const NEGATION_WINDOW = 3;

// Who is speaking: nobody ("Committed both files") or the reply's own voice ("I committed").
// "Alice committed ..." and "The last commit was made by ..." report someone else.
const OWN_VOICE =
	/^(?:(?:ok(?:ay)?|done|great|sure|yes|alright|good|all set|and|then|so|now|also|just|both|successfully|i|we|i've|we've|i have|we have|committed|pushed|ran|executed)\b[\s,:.!-]*)*$/i;
// "The changes have been committed": the thing acted on, then a passive auxiliary.
const OWN_PASSIVE =
	/^(?:(?:all|both|the|these|your|my|our)\s+)*(?:changes?|files?|edits?|work|everything|it|they)\s+(?:(?:has|have|had|is|are|was|were|now|all|been|successfully|just)\s+)*$/i;
// "A commit was made": only an article before the noun the claim itself names.
const ARTICLE_ONLY = /^(?:(?:a|an|the|new|this|that|my|our)\s*)+$/i;
// Credits the action to someone else ("made by Alice").
const BY_SOMEONE = /\bby\s+[A-Z]/;
// A report about the past or about a log, not about this turn.
const NOT_THIS_TURN =
	/\b(?:yesterday|previously|last\s+(?:week|month|year|night|time)|(?:on\s+)?(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{4}-\d{2}-\d{2}|in\s+the\s+previous|originally)\b/i;

/** Does this clause, spoken in the reply's own voice, report the action this turn? */
function clauseClaims(clause: string, says: RegExp): boolean {
	const m = says.exec(clause);
	if (!m) return false;
	if (NOT_THIS_TURN.test(clause)) return false;
	const before = clause.slice(0, m.index).trim();
	const nearby = before.split(/\s+/).filter(Boolean).slice(-NEGATION_WINDOW).join(" ");
	if (GOVERNS.test(nearby)) return false;
	// "Pushed to main by SSH." is the reply's own claim; only a passive subject can credit someone else.
	if (OWN_VOICE.test(before)) return true;
	if (BY_SOMEONE.test(clause)) return false;
	return OWN_PASSIVE.test(`${before} `) || ARTICLE_ONLY.test(before);
}

/** The notes for every action the reply reports that the turn's ledger does not back. */
export function unbackedActionClaims(
	content: string,
	ledger: readonly ToolLedgerEntry[],
	repo?: RepoDelta,
): string[] {
	if (!content) return [];
	const clauses = replyClauses(content);
	return ACTION_CLAIMS.filter(
		(c) => clauses.some((cl) => clauseClaims(cl, c.says)) && !c.backed(ledger, repo),
	).map((c) => c.note(ledger, repo));
}

export interface HonestyGateResult {
	content: string;
	violated: boolean;
	/** True when every failed action was a permission or sandbox refusal (#3899). */
	denied?: boolean;
	reason?: string;
}

/**
 * Law 1 gate: given the model's final reply and the turn's tool ledger,
 * return the reply to actually emit. A completion claim is only allowed
 * through when at least one action tool succeeded this turn.
 */
export function enforceAgenticHonesty(opts: {
	content: string;
	ledger: ToolLedgerEntry[];
	workingDirectory?: string;
	/** Repo at turn start and now; omit when it could not be read. */
	repo?: RepoDelta;
}): HonestyGateResult {
	const { content, ledger, workingDirectory, repo } = opts;
	const actions = ledger.filter((e) => ACTION_TOOLS.has(e.name));
	if (actions.some((e) => e.success)) {
		return actionClaimGate(content, ledger, repo);
	}
	if (!claimsCompletion(content)) {
		return actionClaimGate(content, ledger, repo);
	}
	const failed = actions.filter((e) => !e.success);
	if (failed.length > 0) {
		return {
			content: buildHonestFailureReply(failed, workingDirectory),
			violated: true,
			denied: failed.every((e) => isDenialResult(e.result)),
			reason: `success claim after ${failed.length} failed tool call(s) and zero successes`,
		};
	}
	return {
		content: buildNoActionReply(),
		violated: true,
		reason: "success claim with no action tool call at all",
	};
}

/** The reply stays; what the turn did not do is said under it, in plain words. */
function actionClaimGate(
	content: string,
	ledger: ToolLedgerEntry[],
	repo?: RepoDelta,
): HonestyGateResult {
	const notes = unbackedActionClaims(content, ledger, repo);
	if (notes.length === 0) return { content, violated: false };
	return {
		content: `${content.trimEnd()}\n\n${notes.map((n) => `[harness] ${n}`).join("\n")}`,
		violated: true,
		reason: `action claim without a matching successful call: ${notes.join(" ")}`,
	};
}

/**
 * True when the turn's action tools were all refused by the harness, so the
 * denial is why the task did not happen. Only FAILED results count: the
 * denial text must open the result, so a successful read of a file that
 * contains "permission denied" is not a denial. One refusal the model
 * recovered from (a later action did something else) does not count either.
 */
export function denialIsCause(log: ReadonlyArray<{ name: string; result?: string }>): boolean {
	const actions = log.filter((e) => ACTION_TOOLS.has(e.name));
	const refused = (r: string | undefined) => {
		const head = (r ?? "").trimStart().slice(0, 160);
		if (/^\[[^\]]*\b(BLOCKED|DENIED)\b/.test(head)) return true;
		return /^(Error:|Path blocked|Path traversal blocked)/.test(head) && isDenialResult(head);
	};
	return actions.length > 0 && actions.every((e) => refused(e.result));
}
