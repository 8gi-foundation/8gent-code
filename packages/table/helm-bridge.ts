/**
 * Table -> Helm bridge: the path from "an officer proposes work" to "real work ran
 * and here is the evidence", with a human approval in the middle.
 *
 * The safety model is unchanged and deliberately narrow:
 *  - The OFFICER never executes and never self-authorises. It can only emit a
 *    proposal marker as ordinary channel text through its existing gated post path.
 *  - Only a HUMAN participant (human:*) can approve, by replying with the token.
 *  - The relay bearer secret is read here, daemon-side, and never leaves the
 *    process (never posted to a channel, never handed to a model).
 *  - cwd is checked against the same allowlist Helm itself enforces (defence in
 *    depth: Helm re-checks and is the real boundary).
 *  - Approvals are single-use and expire.
 *
 * Evidence is labelled honestly: `verified` when the daemon watched the worker's
 * output settle, `asserted` when we hit the timeout and are showing a raw tail.
 * The same AgenticHonesty rule the officers follow applies to the bridge itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHarness } from "./harness-config";

const HELM_BASE = process.env.GLASSES_RELAY || "http://127.0.0.1:7890";

/** Worker kinds Helm can run. Kept in lockstep with helm.py's KINDS. */
export type HelmKind = "shell" | "claude" | "codex" | "8gent-local" | "pi" | "cursor-agent" | "opencode";
const KINDS = new Set<HelmKind>(["shell", "claude", "codex", "8gent-local", "pi", "cursor-agent", "opencode"]);

/** Mirrors the relay's own cwd allowlist (helm.py _CWD_CANDIDATES). */
const ALLOWED_CWD_ROOTS = [
	"8gent-glasses", "8gent-worktrees", "8gent-code", "Foodstackai",
	"Documents", "Desktop", "Downloads", "Projects", "code", "src",
].map((d) => path.join(os.homedir(), d));

export interface HelmProposal {
	kind: HelmKind;
	cwd: string;
	command: string;
	/** Model override for the bound harness's own --model flag, when the
	 *  officer's harness names one. Carried through to /helm/spawn. */
	model?: string;
}

export interface PendingApproval extends HelmProposal {
	token: string;
	channelId: string;
	agentId: string;
	createdAt: number;
}

/**
 * Override a freshly-parsed proposal's kind/model with the PROPOSING OFFICER's
 * bound execution harness. Called immediately after parseProposal(), before
 * stagePending(), in table-routes.ts runMentionFlow. The model's own `kind=`
 * text in the marker is deliberately IGNORED here (it is always "shell" in
 * practice - the officer is never taught to name any other kind) in favour of
 * a deterministic, code-owned binding: "agent proposes, code disposes."
 *
 * An officer code the daemon doesn't recognise leaves the parsed proposal
 * unchanged (fail open to whatever the marker already said, which is always a
 * safe, allowlisted `HelmKind` because parseProposal already validated it).
 */
export function bindOfficerHarness(officerCode: string, p: HelmProposal): HelmProposal {
	const harness = resolveHarness(officerCode);
	if (!harness) return p;
	return { ...p, kind: harness.kind, model: harness.model };
}

/** Bearer secret, daemon-side only. Never logged, never posted. */
function bearer(): string | null {
	const env = process.env.PAIRING_SECRET;
	if (env?.trim()) return env.trim();
	try {
		return fs.readFileSync(path.join(os.homedir(), ".8gent", "relay-pairing-secret"), "utf8").trim() || null;
	} catch {
		return null;
	}
}

function expandHome(p: string): string {
	return p.startsWith("~") ? path.join(os.homedir(), p.slice(1).replace(/^\//, "")) : p;
}

/** True when cwd resolves inside an allowed root (no traversal escapes). */
export function isAllowedCwd(cwd: string): boolean {
	const abs = path.resolve(expandHome(cwd));
	return ALLOWED_CWD_ROOTS.some((root) => abs === root || abs.startsWith(`${root}${path.sep}`));
}

/**
 * Parse an officer proposal marker out of a reply. Format (one line):
 *   [[HELM kind=shell cwd=~/8gent-code cmd=git branch --no-merged main | wc -l]]
 * `cmd` runs to the end of the marker so pipes/quotes survive.
 */
export function parseProposal(reply: string): HelmProposal | null {
	// Non-greedy up to the closing "]]", ALLOWING inner "]" - models close the
	// bracket early ("kind=shel]cmd here]]") and a [^\]]+ class silently rejects
	// every one of those.
	const m = reply.match(/\[\[HELM\s+([\s\S]*?)\]\]/);
	// Fallback: officers reliably write the command in a fenced ```bash block
	// (every model does this), but only sometimes emit the marker. Rather than
	// demand an exotic format from a 9-12B local model, treat a short shell block
	// as the proposal. The human still approves, the cwd allowlist still applies,
	// and Helm still enforces its own boundary - the safety model is unchanged.
	if (!m) return parseFencedCommand(reply);
	const body = m[1];
	// Kind is ADVISORY only: the daemon overrides it from the officer's bound
	// harness before staging, so a truncated "kind=shel" must not reject the
	// proposal. Observed live from gemma:
	//     [[HELM kind=shel]cd /packages/table; grep "OFFICER" officers.ts]]
	// - kind truncated, bracket closed early, no cmd= key at all. Rejecting that
	// throws away a good proposal over punctuation.
	const rawKind = body.match(/\bkind=([A-Za-z0-9-]+)/)?.[1] ?? "shell";
	const kind = (KINDS.has(rawKind as HelmKind) ? rawKind : "shell") as HelmKind;
	let cwd = body.match(/\bcwd=(\S+)/)?.[1] ?? "~/8gent-code";

	// Command: prefer an explicit cmd=, else take whatever follows the key/value
	// preamble - that is where these models actually put it.
	let command = body.match(/\bcmd=([\s\S]+)$/)?.[1]?.trim() ?? "";
	if (!command) {
		command = body
			.replace(/\bkind=[A-Za-z0-9-]*\]?/, "")   // eat kind, and a stray "]"
			.replace(/\bcwd=\S+/, "")
			.replace(/^[\s\]:;,-]+/, "")
			.trim();
	}
	command = command.replace(/^(["'])([\s\S]*)\1$/, "$2").replace(/\]+$/, "").trim();
	if (!command) return null;
	if (DESTRUCTIVE.test(command)) return null;

	// A leading "cd <dir> &&" or "cd <dir>;" is how they express the directory
	// far more often than cwd=, so lift it. A relative path here is a model
	// mistake, not a real location - fall back to the default root and let the
	// allowlist judge the result.
	const cd = command.match(/^cd\s+(\S+)\s*(?:&&|;)\s*([\s\S]+)$/);
	if (cd) {
		const candidate = expandHome(cd[1]);
		if (path.isAbsolute(candidate) && isAllowedCwd(candidate)) cwd = candidate;
		command = cd[2].trim();
	}
	return { kind, cwd: expandHome(cwd), command };
}

/** Strip the marker so the channel sees a clean human-readable reply. */
export function stripProposal(reply: string): string {
	return reply.replace(/\[\[HELM\s+[\s\S]*?\]\]/g, "").trim();
}

/** Commands we never auto-stage from a code block - they must be asked for explicitly. */
const DESTRUCTIVE = /\b(rm\s+-|git\s+push\s+.*--force|--force-with-lease|git\s+branch\s+-D|git\s+reset\s+--hard|dd\s+if=|mkfs|shutdown|reboot|killall|chmod\s+777|curl[^|]*\|\s*(ba)?sh)\b/i;

/**
 * Turn a short fenced shell block into a proposal. Deliberately conservative:
 * only a 1-3 line bash/sh/shell block, no destructive verbs, and a `cd <dir> &&`
 * prefix is lifted into cwd (which is then allowlist-checked by the caller).
 */
function parseFencedCommand(reply: string): HelmProposal | null {
	const fence = reply.match(/```(?:bash|sh|shell|console)?\s*\n([\s\S]*?)```/);
	if (!fence) return null;
	const lines = fence[1].split("\n").map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
	if (lines.length === 0 || lines.length > 3) return null;
	let command = lines.join(" && ").replace(/^\$\s*/, "");
	if (DESTRUCTIVE.test(command)) return null;
	// Lift a leading "cd <dir> &&" into cwd so the allowlist can judge it.
	let cwd = path.join(os.homedir(), "8gent-code");
	const cd = command.match(/^cd\s+(\S+)\s*&&\s*([\s\S]+)$/);
	if (cd) {
		cwd = expandHome(cd[1]);
		command = cd[2].trim();
	}
	if (!command) return null;
	return { kind: "shell", cwd, command };
}

// ── pending approvals ────────────────────────────────────────────────────────

const PENDING = new Map<string, PendingApproval>();
const TTL_MS = 15 * 60 * 1000;

function newToken(): string {
	return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function stagePending(p: HelmProposal, channelId: string, agentId: string): PendingApproval {
	for (const [k, v] of PENDING) if (Date.now() - v.createdAt > TTL_MS) PENDING.delete(k);
	let token = newToken();
	while (PENDING.has(token)) token = newToken();
	const entry: PendingApproval = { ...p, token, channelId, agentId, createdAt: Date.now() };
	PENDING.set(token, entry);
	return entry;
}

/** Consume an approval. Single-use; expired or unknown tokens return null. */
export function takePending(token: string): PendingApproval | null {
	const e = PENDING.get(token.toUpperCase());
	if (!e) return null;
	PENDING.delete(e.token);
	if (Date.now() - e.createdAt > TTL_MS) return null;
	return e;
}

/** `/approve ABC123` from a human. Returns the token or null. */
export function parseApproval(content: string): string | null {
	return content.trim().match(/^\/approve\s+([A-Za-z0-9]{4,12})\b/)?.[1]?.toUpperCase() ?? null;
}

// ── Helm HTTP (daemon-side) ──────────────────────────────────────────────────

async function helm(method: "GET" | "POST", route: string, body?: unknown): Promise<{ status: number; json: any }> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	const b = bearer();
	if (b) headers.Authorization = `Bearer ${b}`;
	const res = await fetch(`${HELM_BASE}${route}`, {
		method, headers, body: body === undefined ? undefined : JSON.stringify(body),
	});
	let json: any = null;
	try { json = await res.json(); } catch { /* non-json body */ }
	return { status: res.status, json };
}

export interface ExecutionResult {
	ok: boolean;
	label: "verified" | "asserted" | "failed";
	workerId?: string;
	output: string;
	detail?: string;
}

/**
 * Run an approved proposal: spawn the worker, watch until its output settles,
 * return the tail. `verified` = we watched it settle; `asserted` = we timed out
 * and are showing raw output without claiming completion.
 */
export async function executeApproved(p: PendingApproval, opts?: { timeoutMs?: number }): Promise<ExecutionResult> {
	if (!isAllowedCwd(p.cwd)) {
		return { ok: false, label: "failed", output: "", detail: `cwd not allowed: ${p.cwd}` };
	}
	if (!bearer()) {
		return { ok: false, label: "failed", output: "", detail: "no relay secret available daemon-side" };
	}
	const spawn = await helm("POST", "/helm/spawn", {
		kind: p.kind,
		cwd: p.cwd,
		prompt: p.command,
		...(p.model ? { model: p.model } : {}),
		// Worker->officer attribution (opaque passthrough; Helm never interprets
		// it, only displays it - same trust level as prompt_hash in its ledger).
		meta: { officer: p.agentId.replace(/^agent:/, "") },
	});
	if (spawn.status !== 200 || !spawn.json?.id) {
		return { ok: false, label: "failed", output: "", detail: `spawn failed (${spawn.status}): ${JSON.stringify(spawn.json).slice(0, 200)}` };
	}
	const id = String(spawn.json.id);
	const timeout = opts?.timeoutMs ?? 90_000;
	const started = Date.now();
	let lastOut = "";
	let stableFor = 0;
	while (Date.now() - started < timeout) {
		await new Promise((r) => setTimeout(r, 5_000));
		const out = await helm("GET", `/helm/worker/${id}/output?tail=60`);
		const text = String(out.json?.output ?? "");
		if (text === lastOut && text.trim().length > 0) {
			stableFor += 1;
			// Two consecutive identical non-empty reads = the worker has settled.
			if (stableFor >= 2) {
				await helm("POST", `/helm/worker/${id}/stop`, {});
				return { ok: true, label: "verified", workerId: id, output: tail(text) };
			}
		} else {
			stableFor = 0;
			lastOut = text;
		}
	}
	await helm("POST", `/helm/worker/${id}/stop`, {});
	return { ok: true, label: "asserted", workerId: id, output: tail(lastOut), detail: "timed out before output settled" };
}

/** Last ~25 meaningful lines, so a TUI's redraw noise doesn't flood the channel. */
function tail(text: string): string {
	const lines = text.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim().length > 0);
    return lines.slice(-25).join("\n").slice(-1800);
}
