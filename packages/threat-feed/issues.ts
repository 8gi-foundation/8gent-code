import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Hit, Severity } from "./types";

const ORDER: Severity[] = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** No em dashes and no banned word in anything we author. Advisory text is not copied in. */
const EM_RE = new RegExp(String.fromCharCode(8212), "g");
const clean = (s: string) => s.replace(EM_RE, "-");

export interface IssueDraft {
	repo: string;
	advisoryId: string;
	title: string;
	body: string;
	file: string;
	onKev: boolean;
}

export function meetsMin(h: Hit, min: Severity): boolean {
	return h.onKev || ORDER.indexOf(h.severity) >= ORDER.indexOf(min);
}

/** One draft per repo per advisory. The same advisory on two versions of a package shares one issue. */
export function buildDrafts(hits: Hit[], min: Severity = "UNKNOWN"): IssueDraft[] {
	const groups = new Map<string, Hit[]>();
	for (const h of hits.filter((x) => meetsMin(x, min))) {
		const k = `${h.repo}\0${h.advisoryId}`;
		groups.set(k, [...(groups.get(k) ?? []), h]);
	}
	return [...groups.values()].map((g) => {
		const first = g[0];
		const kev = g.some((h) => h.onKev);
		const title = clean(
			`Security: ${first.advisoryId} in ${[...new Set(g.map((h) => h.package))].join(", ")}${kev ? " (known exploited)" : ""}`,
		);
		const rows = g.map(
			(h) =>
				`- ${h.package} ${h.currentVersion} (${h.ecosystem}) in ${h.files.join(", ")}\n  Proposed bump: ${h.fixedVersion ? `${h.currentVersion} -> ${h.fixedVersion}` : "no fixed version listed upstream"}. No PR opened.`,
		);
		const body = clean(
			[
				"## Finding",
				`Advisory: ${first.advisoryUrl}`,
				`Severity: ${first.severity}${first.cvss !== null ? ` (CVSS ${first.cvss})` : ""}`,
				`CISA Known Exploited Vulnerabilities: ${kev ? `YES (${[...new Set(g.flatMap((h) => h.kevCves))].join(", ")})` : "no"}`,
				first.aliases.length ? `Aliases: ${first.aliases.join(", ")}` : "",
				"",
				"## Affected in this repo",
				...rows,
				"",
				"## Next step",
				"Review the proposed bump and open a normal PR. Nothing is merged or deployed automatically.",
			]
				.filter((l, i, a) => l !== "" || a[i - 1] !== "")
				.join("\n"),
		);
		return { repo: first.repo, advisoryId: first.advisoryId, title, body, file: "", onKev: kev };
	});
}

export function writeDrafts(drafts: IssueDraft[], outDir: string): IssueDraft[] {
	return drafts.map((d, i) => {
		const dir = path.join(outDir, "issues", d.repo.replace("/", "__"));
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(
			dir,
			`${String(i + 1).padStart(3, "0")}-${d.advisoryId.replace(/[^A-Za-z0-9_-]/g, "_")}.md`,
		);
		fs.writeFileSync(file, `# ${d.title}\nLabels: security\nOwner: 8SO\n\n${d.body}\n`);
		return { ...d, file };
	});
}

export type Runner = (repo: string, files: string[]) => string;

/** gh-issue-file skips a title that already exists as an open or closed issue, so a rerun does not duplicate. */
export const defaultRunner: Runner = (repo, files) => {
	const bin = path.join(process.env.HOME ?? "", ".8gent/bin/gh-issue-file");
	const r = spawnSync(bin, ["--repo", repo, ...files], { encoding: "utf8" });
	return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};

export function fileIssues(drafts: IssueDraft[], run: Runner = defaultRunner): string[] {
	const byRepo = new Map<string, string[]>();
	for (const d of drafts) {
		if (!REPO_RE.test(d.repo)) throw new Error(`refusing repo name ${JSON.stringify(d.repo)}`);
		byRepo.set(d.repo, [...(byRepo.get(d.repo) ?? []), d.file]);
	}
	return [...byRepo].map(([repo, files]) => run(repo, files));
}
