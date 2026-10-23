import * as fs from "node:fs";
import * as path from "node:path";
import { rankHits } from "./match";
import type { Hit, RepoInventory } from "./types";

export interface Report {
	generatedAt: string;
	mode: "dry-run" | "file-issues";
	feeds: { osvVulnsFetched: number; osvVulnsFailed: string[]; kevEntries: number };
	repos: { repo: string; lockfiles: number; deps: number; hits: number; skipped: string[] }[];
	totals: { repos: number; deps: number; hits: number; kevHits: number };
	hits: Hit[];
}

export function buildReport(
	inventories: RepoInventory[],
	hits: Hit[],
	feeds: Report["feeds"],
	now: Date,
	mode: Report["mode"] = "dry-run",
): Report {
	const ranked = rankHits(hits);
	return {
		generatedAt: now.toISOString(),
		mode,
		feeds,
		repos: inventories.map((i) => ({
			repo: i.repo,
			lockfiles: i.lockfiles.length,
			deps: i.deps.length,
			hits: hits.filter((h) => h.repo === i.repo).length,
			skipped: i.skipped,
		})),
		totals: {
			repos: inventories.length,
			deps: inventories.reduce((n, i) => n + i.deps.length, 0),
			hits: hits.length,
			kevHits: hits.filter((h) => h.onKev).length,
		},
		hits: ranked,
	};
}

const EM_RE = new RegExp(String.fromCharCode(8212), "g");
const cell = (s: string) => s.replace(/\|/g, "/").replace(EM_RE, "-");

export function renderMarkdown(r: Report, top = 10): string {
	const lines = [
		`# Threat feed report ${r.generatedAt.slice(0, 10)}`,
		"",
		`Mode: ${r.mode}. Repos scanned: ${r.totals.repos}. Unique pinned packages: ${r.totals.deps}.`,
		`Hits: ${r.totals.hits}. On the CISA KEV list: ${r.totals.kevHits}.`,
		"",
		`## Top ${Math.min(top, r.hits.length)}`,
		"",
		"| Repo | Package | Current | Fixed | Severity | KEV | Advisory |",
		"|---|---|---|---|---|---|---|",
		...r.hits
			.slice(0, top)
			.map(
				(h) =>
					`| ${cell(h.repo)} | ${cell(h.package)} | ${cell(h.currentVersion)} | ${h.fixedVersion ? cell(h.fixedVersion) : "none listed"} | ${h.severity} | ${h.onKev ? "YES" : "no"} | ${h.advisoryUrl} |`,
			),
		"",
		"## Coverage gaps",
		"",
	];
	const gaps = r.repos.filter((x) => x.skipped.length);
	if (!gaps.length) lines.push("None.");
	for (const g of gaps) lines.push(`- ${g.repo}: ${g.skipped.map(cell).join("; ")}`);
	if (r.feeds.osvVulnsFailed.length) {
		lines.push(
			"",
			`OSV detail lookups failed for ${r.feeds.osvVulnsFailed.length} advisories; their severity and fix are missing.`,
		);
	}
	return `${lines.join("\n")}\n`;
}

export function writeReport(r: Report, outDir: string): { json: string; md: string } {
	fs.mkdirSync(outDir, { recursive: true });
	const json = path.join(outDir, "report.json");
	const md = path.join(outDir, "summary.md");
	fs.writeFileSync(json, `${JSON.stringify(r, null, 2)}\n`);
	fs.writeFileSync(md, renderMarkdown(r));
	return { json, md };
}
