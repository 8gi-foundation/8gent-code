#!/usr/bin/env bun
/**
 * factory-yield: read-only report of factory yield per merged PR.
 * Columns: linked issue, hours from issue creation to merge, steering rounds
 * (CHANGES_REQUESTED reviews plus FIX FIRST comments on the PR itself, plus
 * the optional local --steering-ledger), tokens.
 * The factory records most review rounds in the local merge-ready.txt, not on
 * GitHub: steering-ledger counts distinct MERGE-OK heads and FIX FIRST NOTE rows
 * per PR (read with grep -a semantics, so stray binary bytes do not matter).
 * GitHub does not hold tokens, so that column reads n/a unless
 * --tokens-ledger <jsonl> is given with rows {pr, tokens}.
 *
 * Usage: bun scripts/factory-yield.ts [--limit N] [--json] [--tokens-ledger path]
 *        [--steering-ledger path]
 * Auth: GH_TOKEN env or `gh auth token`; sent only in an Authorization header.
 */
import { readFileSync } from "node:fs";

const REPO = "8gi-foundation/8gent-code";

export interface Review {
	state?: string;
	body?: string | null;
}
export interface Comment {
	body?: string | null;
}
export interface YieldRow {
	pr: number;
	title: string;
	issue: number | null;
	hours: number | null;
	steering: number;
	tokens: number | null;
}

export function parseLinkedIssue(body: string | null | undefined): number | null {
	const m = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(body ?? "");
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function countSteeringRounds(
	reviews: Review[],
	issueComments: Comment[],
	reviewComments: Comment[],
): number {
	const changes = reviews.filter((r) => r.state === "CHANGES_REQUESTED").length;
	const fix = [...issueComments, ...reviewComments].filter((c) =>
		/FIX FIRST/i.test(c.body ?? ""),
	).length;
	return changes + fix;
}

export function hoursBetween(startIso: string, endIso: string): number | null {
	const a = Date.parse(startIso);
	const b = Date.parse(endIso);
	if (Number.isNaN(a) || Number.isNaN(b)) return null;
	return Math.round(((b - a) / 3_600_000) * 10) / 10;
}

export function renderTable(rows: YieldRow[]): string {
	const head = "| PR | Issue | Hours to merge | Steering rounds | Tokens |\n|---|---|---|---|---|";
	const lines = rows.map(
		(r) =>
			`| #${r.pr} | ${r.issue === null ? "n/a" : "#" + r.issue} | ${r.hours === null ? "n/a" : r.hours} | ${r.steering} | ${r.tokens === null ? "n/a" : r.tokens} |`,
	);
	return [head, ...lines].join("\n");
}

export function parseTokensLedger(text: string): Map<number, number> {
	const out = new Map<number, number>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line);
			if (
				Number.isSafeInteger(row?.pr) &&
				row.pr > 0 &&
				Number.isFinite(row.tokens) &&
				row.tokens >= 0
			) {
				const sum = (out.get(row.pr) ?? 0) + row.tokens;
				if (Number.isFinite(sum)) out.set(row.pr, sum);
			}
		} catch {
			// skip malformed ledger lines
		}
	}
	return out;
}

/**
 * Local review rounds per PR from merge-ready.txt text: distinct MERGE-OK heads
 * (one per re-reviewed head) plus NOTE rows that say FIX FIRST.
 */
export function parseSteeringLedger(text: string): Map<number, number> {
	const heads = new Map<number, Set<string>>();
	const fixFirst = new Map<number, number>();
	for (const line of text.split("\n")) {
		const ok = /^MERGE-OK\s+\S*?8gent-code#(\d+)\s+at\s+([0-9a-f]{7,40})\b/i.exec(line);
		if (ok) {
			const pr = Number(ok[1]);
			if (!Number.isSafeInteger(pr) || pr <= 0) continue;
			const set = heads.get(pr) ?? new Set<string>();
			set.add(ok[2].toLowerCase());
			heads.set(pr, set);
			continue;
		}
		const note = /^NOTE\s+\S*?8gent-code#(\d+)\b/i.exec(line);
		if (note && /FIX FIRST/i.test(line)) {
			const pr = Number(note[1]);
			if (Number.isSafeInteger(pr) && pr > 0) fixFirst.set(pr, (fixFirst.get(pr) ?? 0) + 1);
		}
	}
	const out = new Map<number, number>();
	for (const pr of new Set([...heads.keys(), ...fixFirst.keys()])) {
		out.set(pr, (heads.get(pr)?.size ?? 0) + (fixFirst.get(pr) ?? 0));
	}
	return out;
}

async function getToken(): Promise<string> {
	if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
	const p = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
	const t = (await new Response(p.stdout).text()).trim();
	if (!t) throw new Error("no GitHub token: set GH_TOKEN or run gh auth login");
	return t;
}

async function main() {
	const args = process.argv.slice(2);
	const flag = (n: string) => args.indexOf(n);
	const asJson = flag("--json") >= 0;
	const li = flag("--limit");
	const limit = li >= 0 ? Number(args[li + 1]) || 30 : 30;
	const ti = flag("--tokens-ledger");
	const tokens =
		ti >= 0 ? parseTokensLedger(readFileSync(args[ti + 1], "utf8")) : new Map<number, number>();

	const si = flag("--steering-ledger");
	const local =
		si >= 0 ? parseSteeringLedger(readFileSync(args[si + 1], "latin1")) : new Map<number, number>();

	const token = await getToken();
	const api = async (path: string): Promise<any> => {
		const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
		});
		if (!res.ok) throw new Error(`GitHub ${res.status} for ${path.split("?")[0]}`);
		return res.json();
	};
	const apiAll = async (path: string): Promise<any[]> => {
		const all: any[] = [];
		for (let page = 1; page <= 20; page++) {
			const batch = await api(`${path}?per_page=100&page=${page}`);
			all.push(...batch);
			if (batch.length < 100) break;
		}
		return all;
	};

	const merged: any[] = [];
	for (let page = 1; merged.length < limit && page <= 20; page++) {
		const batch = await api(
			`pulls?state=closed&sort=updated&direction=desc&per_page=50&page=${page}`,
		);
		if (!batch.length) break;
		merged.push(...batch.filter((p: any) => p.merged_at));
	}

	const rows: YieldRow[] = [];
	for (const pr of merged.slice(0, limit)) {
		let issue = parseLinkedIssue(pr.body);
		let hours: number | null = null;
		if (issue !== null) {
			try {
				const issueData = await api(`issues/${issue}`);
				hours = hoursBetween(issueData.created_at, pr.merged_at);
			} catch {
				issue = null; // deleted, transferred or missing: show n/a, keep going
			}
		}
		let steering = local.get(pr.number) ?? 0;
		try {
			const [reviews, reviewComments, prIssueComments] = await Promise.all([
				apiAll(`pulls/${pr.number}/reviews`),
				apiAll(`pulls/${pr.number}/comments`),
				apiAll(`issues/${pr.number}/comments`),
			]);
			// Only the PR's own threads: comments on a shared or epic issue
			// would inflate every PR that closes it.
			steering += countSteeringRounds(reviews, prIssueComments, reviewComments);
		} catch {
			// keep the local count; GitHub part unavailable for this PR
		}
		rows.push({
			pr: pr.number,
			title: pr.title,
			issue,
			hours,
			steering,
			tokens: tokens.get(pr.number) ?? null,
		});
	}

	console.log(asJson ? JSON.stringify(rows, null, 2) : renderTable(rows));
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(String(e?.message ?? e));
		process.exit(1);
	});
}
