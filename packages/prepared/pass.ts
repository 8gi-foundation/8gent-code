/**
 * The idle pass (Owned Duet, #5233 slice 1, layers Context + Prepare).
 *
 * Finds candidates (stale TODOs, failing tests from a log, issues assigned to
 * the owner), turns each into one approval packet, classifies it, and writes it
 * to the prepared dir. Every read and write goes through PreparedIO, so the
 * policy engine, not convention, keeps the pass inside the prepared dir.
 * A drafter is local by default; a non-loopback model URL is refused.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { classifyAction } from "../permissions/action-tiers.js";
import {
	DEFAULT_NEVER,
	type Packet,
	type TaskSpec,
	buildApplyCommand,
	buildUndoCommand,
	packetId,
	patchBytes,
	sq,
	wrapUntrusted,
} from "./packet.js";
import { loadProfile, recordAsked, rejectedSimilarity, saveProfile } from "./rank.js";
import type { PreparedIO } from "./store.js";

export interface Candidate {
	kind: "todo" | "test" | "issue";
	ref: string;
	path?: string;
	title: string;
	/** Fetched text. Untrusted. */
	text: string;
	whyNow: string;
	assignedToOwner?: boolean;
}

export interface Draft {
	draft: string;
	diff: string;
	confidence: number;
}
export type Drafter = (c: Candidate, rules: string) => Promise<Draft>;

// ---------------- finders (read-only) ----------------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "worktrees"]);
const CODE = /\.(ts|tsx|js|mjs|py|sh|rs|go)$/;

export function findTodos(io: PreparedIO, staleDays: number, now: Date, limit = 5): Candidate[] {
	const out: Candidate[] = [];
	const cutoff = now.getTime() - staleDays * 86_400_000;
	const walk = (rel: string, depth: number) => {
		if (out.length >= limit || depth > 6) return;
		let names: string[];
		try {
			names = io.list(path.join(io.workspace, rel));
		} catch {
			return;
		}
		for (const n of names.sort()) {
			if (out.length >= limit) return;
			const r = path.join(rel, n);
			const abs = path.join(io.workspace, r);
			let st: ReturnType<PreparedIO["stat"]>;
			try {
				st = io.stat(abs);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (!SKIP_DIRS.has(n)) walk(r, depth + 1);
			} else if (CODE.test(n) && st.size < 200_000 && st.mtimeMs < cutoff) {
				const lines = io.read(abs).split("\n");
				lines.forEach((l, i) => {
					const m = /\b(TODO|FIXME)\b[:\s]+(.{6,120})/.exec(l);
					if (m && out.length < limit) {
						out.push({
							kind: "todo",
							ref: `${r}:${i + 1}`,
							path: r,
							title: `Resolve ${m[1]} in ${r}: ${m[2].trim()}`,
							text: lines.slice(Math.max(0, i - 3), i + 4).join("\n"),
							whyNow: `${m[1]} in a file untouched for over ${staleDays} days`,
						});
					}
				});
			}
		}
	};
	walk("", 0);
	return out;
}

/** inputs/test.log is written by the owner's test run: lines like "(fail) name". */
export function findFailingTests(io: PreparedIO, limit = 5): Candidate[] {
	if (!io.exists("inputs/test.log")) return [];
	return io
		.read("inputs/test.log")
		.split("\n")
		.map((l) => /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+ms\])?$/.exec(l))
		.filter((m): m is RegExpExecArray => !!m)
		.slice(0, limit)
		.map((m) => ({
			kind: "test" as const,
			ref: `test-log:${m[1]}`,
			title: `Fix failing test: ${m[1]}`,
			text: m[0],
			whyNow: "failing in the last recorded test run",
		}));
}

/** inputs/issues.json: [{number,title,body,labels,assignedToOwner}] cached from the forge by the owner's tooling. */
export function findIssues(io: PreparedIO, limit = 5): Candidate[] {
	if (!io.exists("inputs/issues.json")) return [];
	const rows = JSON.parse(io.read("inputs/issues.json")) as {
		number: number;
		title: string;
		body?: string;
		labels?: string[];
		assignedToOwner?: boolean;
	}[];
	return rows
		.filter((r) => r.assignedToOwner || (r.labels ?? []).length > 0)
		.slice(0, limit)
		.map((r) => ({
			kind: "issue" as const,
			ref: `issue#${r.number}`,
			title: `Prepare a fix for #${r.number}: ${r.title}`,
			text: `${r.title}\n${r.body ?? ""}`,
			whyNow: r.assignedToOwner
				? "assigned to you and open"
				: `labelled ${(r.labels ?? []).join(", ")}`,
			assignedToOwner: !!r.assignedToOwner,
		}));
}

// ---------------- drafters ----------------

const BASE_CONFIDENCE = { todo: 0.25, test: 0.3, issue: 0.35 } as const;

export const deterministicDrafter: Drafter = async (c) => ({
	draft: `${c.title}\nWhy now: ${c.whyNow}\nContext:\n${c.text.slice(0, 600)}`,
	diff: "",
	confidence: BASE_CONFIDENCE[c.kind],
});

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Local model by default. Anything off-box is refused in slice 1 (the sensitivity filter, #5014, is not built yet). */
export function assertLocalUrl(url: string): void {
	const host = new URL(url).hostname.toLowerCase();
	if (!LOOPBACK.has(host)) {
		throw new Error(
			`prepared: model endpoint ${host} is not on this machine; cloud drafting is not enabled`,
		);
	}
}

export function modelDrafter(url: string, model: string, fetchFn: typeof fetch = fetch): Drafter {
	assertLocalUrl(url);
	return async (c, rules) => {
		const prompt = [
			"Prepare a minimal unified diff for the task. Output a ```diff block, or say NO DIFF.",
			`Owner rules, verbatim:\n${rules}`,
			`Task: ${c.title}`,
			wrapUntrusted(c.text, c.ref),
		].join("\n\n");
		const res = await fetchFn(`${url.replace(/\/$/, "")}/api/generate`, {
			method: "POST",
			// A loopback URL that redirects off the box would carry the prompt with it.
			redirect: "error",
			body: JSON.stringify({ model, prompt, stream: false }),
		});
		const body = (await res.json()) as { response?: string };
		const text = body.response ?? "";
		const diff = /```diff\n([\s\S]*?)```/.exec(text)?.[1] ?? "";
		return {
			draft: text.slice(0, 2000),
			diff,
			confidence: diff ? 0.5 : BASE_CONFIDENCE[c.kind],
		};
	};
}

export function drafterFromEnv(env: Record<string, string | undefined> = process.env): Drafter {
	const url = env.EIGHT_PREPARED_MODEL_URL;
	const model = env.EIGHT_PREPARED_MODEL;
	return url && model ? modelDrafter(url, model) : deterministicDrafter;
}

// ---------------- idle ----------------

export function shouldRunIdle(o: {
	now: number;
	lastActivity: number;
	lastPass: number;
	idleMs?: number;
	minGapMs?: number;
}): boolean {
	return (
		o.now - o.lastActivity >= (o.idleMs ?? 10 * 60_000) &&
		o.now - o.lastPass >= (o.minGapMs ?? 6 * 3_600_000)
	);
}

// ---------------- the pass ----------------

export interface PassOptions {
	now?: Date;
	rng?: () => number;
	drafter?: Drafter;
	staleDays?: number;
	max?: number;
	expiresHours?: number;
	candidates?: Candidate[];
}

export interface PassResult {
	prepared: string[];
	blocked: { id: string; reason: string }[];
	skipped: number;
}

/** Read-only git in the workspace. Never writes. */
function git(io: PreparedIO, args: string[]): { code: number; out: string } {
	const r = spawnSync("git", ["-C", io.workspace, ...args], { encoding: "utf8" });
	return { code: r.status ?? 1, out: r.stdout ?? "" };
}

const SHA = /^[0-9a-f]{40}$/;

/** The workspace HEAD as a full commit sha, or null when there is none. */
export function headCommit(io: PreparedIO): string | null {
	const r = git(io, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
	const sha = r.out.trim();
	return r.code === 0 && SHA.test(sha) ? sha : null;
}

/**
 * A packet's base is trusted only when it is a full sha already in the
 * owner's history (HEAD or an ancestor of it), never a fetched branch tip.
 */
export function isTrustedBase(io: PreparedIO, base: string | undefined): base is string {
	if (!base || !SHA.test(base)) return false;
	return git(io, ["merge-base", "--is-ancestor", base, "HEAD"]).code === 0;
}

/**
 * The gate, resolved from the base commit with `git show <base>:package.json`,
 * never from a working copy and never from the patched worktree: the literal
 * body of its "typecheck" script, run with sh -c in the worktree. Approve calls
 * this again with the packet's base and refuses if it changed.
 */
export function gateCommand(io: PreparedIO, base: string | null = headCommit(io)): string {
	if (base && SHA.test(base)) {
		const r = git(io, ["show", `${base}:package.json`]);
		try {
			const body = r.code === 0 ? JSON.parse(r.out).scripts?.typecheck : undefined;
			if (typeof body === "string" && body.trim()) return `sh -c ${sq(body)}`;
		} catch {}
	}
	return "git diff --cached --check";
}

export async function runPass(io: PreparedIO, opts: PassOptions = {}): Promise<PassResult> {
	const now = opts.now ?? new Date();
	const drafter = opts.drafter ?? drafterFromEnv();
	const profile = loadProfile(io);
	const arm = io.armFor(now, opts.rng);
	const rulesPath = path.join(path.dirname(io.dir), "officers", "8TO", "rules.md");
	const rules = io.exists(rulesPath) ? io.read(rulesPath) : "";
	const rulesSha = createHash("sha256").update(rules).digest("hex").slice(0, 12);
	const base = headCommit(io);
	const gate = gateCommand(io, base);

	const cands = opts.candidates ?? [
		...findFailingTests(io),
		...findIssues(io),
		...findTodos(io, opts.staleDays ?? 30, now),
	];
	const res: PassResult = { prepared: [], blocked: [], skipped: 0 };

	for (const c of cands.slice(0, opts.max ?? 10)) {
		if (c.assignedToOwner)
			recordAsked(profile, {
				title: c.title,
				source: { origin: "untrusted", ref: c.ref, kind: c.kind, path: c.path },
			});
		if (rejectedSimilarity(profile, c.title) >= 0.8) {
			res.skipped++;
			continue;
		}
		let d: Draft;
		try {
			d = await drafter(c, rules);
		} catch {
			d = await deterministicDrafter(c, rules);
		}
		const spec: TaskSpec = {
			done_when: d.diff
				? "the diff applies in a worktree and the gate is green"
				: "the owner has read the draft",
			budget: { max_files: 5, max_seconds: 600 },
			never: DEFAULT_NEVER,
			on_block: "stop, write what is missing to blocked/, send nothing",
		};
		const action = d.diff
			? { kind: "apply_diff_worktree", target: io.workspace, payload: d.diff, command: "" }
			: { kind: "accept_draft", target: "prepared", payload: d.draft };
		if (d.diff && !base) {
			res.skipped++;
			continue;
		}
		const id = d.diff ? packetId(action, base!) : packetId(action);
		if (d.diff) action.command = buildApplyCommand(io.workspace, io.dir, id, gate, base!);
		if (io.exists(`${id}.json`) || io.exists(`blocked/${id}.json`)) {
			res.skipped++;
			continue;
		}
		const packet: Packet = {
			id,
			title: c.title,
			why: c.whyNow,
			action,
			why_now: c.whyNow,
			undo: d.diff
				? buildUndoCommand(io.workspace, io.dir, id)
				: "nothing to undo; no files change",
			expires: new Date(now.getTime() + (opts.expiresHours ?? 24) * 3_600_000).toISOString(),
			evidence: [c.ref, `finder:${c.kind}`, `rules:sha256:${rulesSha}`],
			source: { origin: "untrusted", ref: c.ref, kind: c.kind, path: c.path },
			spec,
			confidence: d.confidence,
			draft: d.draft,
			apply: action.command ?? "",
			gate,
			...(d.diff ? { base: base! } : {}),
			createdAt: now.toISOString(),
			status: "prepared",
		};
		const tier = classifyAction(action, { untrusted: true });
		const files = (d.diff.match(/^diff --git /gm) ?? []).length;
		const over =
			files > spec.budget.max_files
				? `diff touches ${files} files, budget is ${spec.budget.max_files}`
				: "";
		if (tier.tier === "blocked" || over) {
			const reason = over || tier.reason;
			io.write(
				`blocked/${id}.json`,
				`${JSON.stringify({ id, title: c.title, spec, missing: reason, source: packet.source }, null, 2)}\n`,
			);
			io.ledger({ event: "blocked", id, confidence: d.confidence, arm, reason }, now);
			res.blocked.push({ id, reason });
			continue;
		}
		if (d.diff) io.write(`${id}.patch`, patchBytes(d.diff), 0o444);
		io.savePacket(packet);
		io.ledger({ event: "prepared", id, confidence: d.confidence, arm }, now);
		res.prepared.push(id);
	}
	saveProfile(io, profile);
	return res;
}
