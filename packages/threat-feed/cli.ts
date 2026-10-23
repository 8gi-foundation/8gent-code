#!/usr/bin/env bun
import * as os from "node:os";
import * as path from "node:path";
import { defaultOutRoot, ghToken, run } from "./index";
import type { Severity } from "./types";

const USAGE = `usage: bun packages/threat-feed/cli.ts [--file-issues] [--min-severity LOW|MEDIUM|HIGH|CRITICAL]
  [--repo OWNER/NAME ...] [--manifest PATH] [--out DIR]
Dry-run by default: reads lockfiles and feeds, writes report.json and summary.md only.
--file-issues opens one issue per repo (a checklist of its advisories at or above --min-severity) through ~/.8gent/bin/gh-issue-file.`;

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const vals = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
if (flag("--help") || flag("-h")) {
	console.log(USAGE);
	process.exit(0);
}
const sev = (vals("--min-severity")[0] ?? "UNKNOWN").toUpperCase() as Severity;
if (!["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(sev)) {
	console.error(USAGE);
	process.exit(2);
}
const { report, paths, issueLog } = await run({
	manifestPath:
		vals("--manifest")[0] ?? path.join(os.homedir(), "8gi-governance/context/ecosystem.json"),
	outRoot: vals("--out")[0] ?? defaultOutRoot(),
	fileIssues: flag("--file-issues"),
	minSeverity: sev,
	only: vals("--repo"),
	token: ghToken(),
	log: (s) => console.error(s),
});
console.log(
	`hits=${report.totals.hits} kev=${report.totals.kevHits} repos=${report.totals.repos} deps=${report.totals.deps}`,
);
console.log(`report: ${paths.json}\nsummary: ${paths.md}`);
for (const l of issueLog)
	console.log(
		`${l.action} ${l.repo}${l.number ? ` #${l.number}` : ""}${l.action === "failed" ? `: ${l.log}` : ""}`,
	);
