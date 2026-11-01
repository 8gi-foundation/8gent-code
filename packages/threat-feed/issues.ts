import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isName, isToken } from "./match";
import type { Hit, Severity } from "./types";

const ORDER: Severity[] = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function assertRepo(repo: string): void {
	const bad = !REPO_RE.test(repo) || repo.split("/").some((seg) => /^\.+$/.test(seg));
	if (bad) throw new Error(`refusing repo name ${JSON.stringify(repo)}`);
}

/**
 * Everything printed from a hit is checked again here, so a caller that builds a Hit by hand
 * cannot get raw third-party text into an issue. Values are always wrapped in backticks.
 */
const tick = (s: string) => {
	if (!isName(s) && !isToken(s))
		throw new Error(`refusing to print ${JSON.stringify(s).slice(0, 40)}`);
	return `\`${s}\``;
};

export interface IssueDraft {
	repo: string;
	title: string;
	/** Checklist only. Comments on later runs carry this text. */
	checklist: string;
	body: string;
	digest: string;
	count: number;
	file: string;
	onKev: boolean;
}

export function meetsMin(h: Hit, min: Severity): boolean {
	return h.onKev || ORDER.indexOf(h.severity) >= ORDER.indexOf(min);
}

const prodRank = (h: Hit) => (h.devOnly === false ? 0 : h.devOnly === null ? 1 : 2);

/** Non-dev-only first, then unknown, then dev-only. KEV, CVSS and name break ties. */
export function sortForChecklist(hits: Hit[]): Hit[] {
	return [...hits].sort(
		(a, b) =>
			prodRank(a) - prodRank(b) ||
			Number(b.onKev) - Number(a.onKev) ||
			(b.cvss ?? 0) - (a.cvss ?? 0) ||
			a.package.localeCompare(b.package) ||
			a.currentVersion.localeCompare(b.currentVersion) ||
			a.advisoryId.localeCompare(b.advisoryId),
	);
}

function row(h: Hit): string {
	const fixed = h.fixedVersionInvalid
		? "no valid fixed version"
		: h.fixedVersion
			? tick(h.fixedVersion)
			: "no fixed version listed upstream";
	const dev = h.devOnly === null ? "unknown" : h.devOnly ? "yes" : "no";
	return `- [ ] ${tick(h.package)} ${tick(h.currentVersion)}, fixed in ${fixed}. Dev-only: ${dev}. ${h.onKev ? "KNOWN EXPLOITED. " : ""}Advisory ${tick(h.advisoryId)}: https://osv.dev/vulnerability/${tick(h.advisoryId).slice(1, -1)}`;
}

export function repoTitle(repo: string): string {
	assertRepo(repo);
	return `Critical dependency advisories: ${repo.split("/")[1]}`;
}

/** One draft per repo. Rows are one per package version per advisory. Proposed bumps are listed, no PR is opened. */
export function buildDrafts(hits: Hit[], min: Severity = "UNKNOWN"): IssueDraft[] {
	const byRepo = new Map<string, Hit[]>();
	for (const h of hits.filter((x) => meetsMin(x, min))) {
		assertRepo(h.repo);
		byRepo.set(h.repo, [...(byRepo.get(h.repo) ?? []), h]);
	}
	return [...byRepo].map(([repo, hs]) => {
		const sorted = sortForChecklist(hs);
		const checklist = sorted.map(row).join("\n");
		const digest = createHash("sha256").update(checklist).digest("hex").slice(0, 12);
		const kev = sorted.some((h) => h.onKev);
		const body = [
			"## Findings",
			`${sorted.length} dependency advisories at or above the threshold are open against this repo. Production and unknown dependencies are listed first, dev-only last.`,
			"",
			"## Checklist",
			checklist,
			"",
			"## Next step",
			"Review each proposed bump and open a normal PR. Nothing is merged or deployed automatically. When the findings change, an updated checklist is added as a comment.",
			"",
			`Checklist digest: ${digest}`,
		].join("\n");
		return {
			repo,
			title: repoTitle(repo),
			checklist,
			body,
			digest,
			count: sorted.length,
			file: "",
			onKev: kev,
		};
	});
}

export function writeDrafts(drafts: IssueDraft[], outDir: string): IssueDraft[] {
	// Validate every repo before any path is built from it.
	for (const d of drafts) assertRepo(d.repo);
	return drafts.map((d) => {
		const dir = path.join(outDir, "issues", d.repo.replace("/", "__"));
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "critical-advisories.md");
		fs.writeFileSync(file, `# ${d.title}\nLabels: security\nOwner: 8SO\n\n${d.body}\n`);
		return { ...d, file };
	});
}

export type Runner = (repo: string, files: string[]) => string;
export type Commenter = (repo: string, issue: number, bodyFile: string) => string;

const bin = (n: string) => path.join(process.env.HOME ?? "", ".8gent/bin", n);

/** gh-issue-file skips a title that already exists as an open or closed issue, so a rerun never duplicates. */
export const defaultRunner: Runner = (repo, files) => {
	const r = spawnSync(bin("gh-issue-file"), ["--repo", repo, ...files], { encoding: "utf8" });
	return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};

/** gh-issue-comment only adds a comment. The issue body is never edited. */
export const defaultCommenter: Commenter = (repo, issue, bodyFile) => {
	const r = spawnSync(bin("gh-issue-comment"), ["--repo", repo, String(issue), bodyFile], {
		encoding: "utf8",
	});
	return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};

type State = Record<string, { number: number; digest: string }>;

export interface FileResult {
	repo: string;
	action: "filed" | "unchanged" | "commented" | "failed";
	number?: number;
	log: string;
}

/**
 * File one issue per repo. If the issue already exists (same title), compare the checklist digest
 * with the one recorded from the last run and, only when it changed, add the new checklist as a comment.
 */
export function fileIssues(
	drafts: IssueDraft[],
	opts: { run?: Runner; comment?: Commenter; stateFile: string; tmpDir: string },
): FileResult[] {
	const run = opts.run ?? defaultRunner;
	const comment = opts.comment ?? defaultCommenter;
	for (const d of drafts) assertRepo(d.repo);
	const state: State = fs.existsSync(opts.stateFile)
		? JSON.parse(fs.readFileSync(opts.stateFile, "utf8"))
		: {};
	const results: FileResult[] = [];
	for (const d of drafts) {
		const out = run(d.repo, [d.file]);
		const m = out.match(/(FILED|EXISTS) #(\d+)/);
		if (!m) {
			results.push({ repo: d.repo, action: "failed", log: out.trim().slice(0, 300) });
			continue;
		}
		const number = Number(m[2]);
		if (m[1] === "FILED") {
			state[d.repo] = { number, digest: d.digest };
			results.push({ repo: d.repo, action: "filed", number, log: out.trim() });
		} else if (state[d.repo]?.number === number && state[d.repo].digest === d.digest) {
			results.push({ repo: d.repo, action: "unchanged", number, log: out.trim() });
		} else {
			fs.mkdirSync(opts.tmpDir, { recursive: true });
			const f = path.join(opts.tmpDir, `${d.repo.replace("/", "__")}-update.md`);
			fs.writeFileSync(f, `Updated checklist (digest ${d.digest}):\n\n${d.checklist}\n`);
			const co = comment(d.repo, number, f);
			const ok = !/error|denied|not allowed|HTTP [45]/i.test(co);
			if (ok) state[d.repo] = { number, digest: d.digest };
			results.push({
				repo: d.repo,
				action: ok ? "commented" : "failed",
				number,
				log: co.trim().slice(0, 300),
			});
		}
	}
	fs.mkdirSync(path.dirname(opts.stateFile), { recursive: true });
	fs.writeFileSync(opts.stateFile, `${JSON.stringify(state, null, 2)}\n`);
	return results;
}
