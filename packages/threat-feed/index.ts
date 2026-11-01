import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Fetch, fetchKev, fetchVulns, queryOsv } from "./feeds";
import { type EcosystemManifest, inventoryRepo, repoList } from "./inventory";
import {
	type Commenter,
	type FileResult,
	type Runner,
	buildDrafts,
	fileIssues,
	writeDrafts,
} from "./issues";
import { matchRepo } from "./match";
import { type Report, buildReport, writeReport } from "./report";
import type { Severity } from "./types";

export interface RunOptions {
	manifestPath: string;
	outRoot: string;
	fileIssues: boolean;
	minSeverity: Severity;
	only?: string[];
	token: string;
	fetch?: Fetch;
	now?: Date;
	runner?: Runner;
	commenter?: Commenter;
	log?: (s: string) => void;
}

export async function run(o: RunOptions) {
	const f = o.fetch ?? fetch;
	const log = o.log ?? (() => {});
	const now = o.now ?? new Date();
	const manifest = JSON.parse(fs.readFileSync(o.manifestPath, "utf8")) as EcosystemManifest;
	const repos = o.only?.length ? o.only : repoList(manifest);
	const inventories = [];
	for (const r of repos) {
		const inv = await inventoryRepo(r, o.token, f);
		log(
			`inventory ${r}: ${inv.deps.length} deps, ${inv.lockfiles.length} lockfiles${inv.skipped.length ? `, ${inv.skipped.length} skipped` : ""}`,
		);
		inventories.push(inv);
	}
	const allDeps = inventories.flatMap((i) => i.deps);
	const idsByDep = await queryOsv(allDeps, f);
	const ids = [...idsByDep.values()].flat();
	const { vulns, failed } = await fetchVulns(ids, f);
	const kev = await fetchKev(f);
	const hits = inventories.flatMap((inv) =>
		matchRepo({ repo: inv.repo, deps: inv.deps, idsByDep, vulns, kev }),
	);
	const report: Report = buildReport(
		inventories,
		hits,
		{ osvVulnsFetched: vulns.size, osvVulnsFailed: failed, kevEntries: kev.size },
		now,
		o.fileIssues ? "file-issues" : "dry-run",
	);
	const outDir = path.join(o.outRoot, now.toISOString().slice(0, 10));
	const paths = writeReport(report, outDir);
	let issueLog: FileResult[] = [];
	if (o.fileIssues) {
		const drafts = writeDrafts(buildDrafts(report.hits, o.minSeverity), outDir);
		issueLog = fileIssues(drafts, {
			run: o.runner,
			comment: o.commenter,
			stateFile: path.join(o.outRoot, "issue-state.json"),
			tmpDir: path.join(outDir, "issues"),
		});
	}
	return { report, paths, issueLog };
}

export function ghToken(): string {
	const t = spawnSync("gh", ["auth", "token"], { encoding: "utf8" }).stdout.trim();
	if (!t) throw new Error("no GitHub token from gh auth token");
	return t;
}

export const defaultOutRoot = () => path.join(os.homedir(), ".8gent/security/threat-feed");
