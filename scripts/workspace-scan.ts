// Workspace scan: find UNFINISHED work so a Table agent can help triage it.
//  1. Unfinished branches  - local branches not merged into the repo's default
//     branch, with how stale they are (days since last commit) and ahead/behind.
//  2. Unfinished sessions  - Claude Code transcripts (~/.claude/projects/*/*.jsonl)
//     whose LAST event is a human turn (the agent never got to finish), recent-first.
// Read-only. Prints JSON to stdout + a short human summary to stderr.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const DAYS = (ms: number) => Math.floor((Date.now() - ms) / 86_400_000);

function sh(cmd: string, args: string[], cwd: string): string {
	try { return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
	catch { return ""; }
}

// ---- 1. branches ----
type BranchFinding = { repo: string; branch: string; staleDays: number; ahead: number; behind: number; lastSubject: string };

function scanBranches(): BranchFinding[] {
	const out: BranchFinding[] = [];
	const entries = fs.readdirSync(HOME, { withFileTypes: true });
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const repo = path.join(HOME, e.name);
		// Only real clones: a worktree's .git is a FILE pointing at the main repo,
		// so its branches would be counted again under the clone. Skip those.
		try { if (!fs.statSync(path.join(repo, ".git")).isDirectory()) continue; } catch { continue; }
		// default branch
		let def = sh("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo).replace(/^origin\//, "");
		if (!def) def = ["main", "master"].find((b) => sh("git", ["rev-parse", "--verify", b], repo)) || "main";
		const branches = sh("git", ["for-each-ref", "--format=%(refname:short)\t%(committerdate:unix)\t%(subject)", "refs/heads"], repo).split("\n").filter(Boolean);
		for (const line of branches) {
			const [branch, ts, ...rest] = line.split("\t");
			if (branch === def) continue;
			// unmerged into default?
			const merged = sh("git", ["branch", "--merged", def], repo).split("\n").map((s) => s.replace(/^[*+ ]+/, "").trim());
			if (merged.includes(branch)) continue;
			const ahead = Number(sh("git", ["rev-list", "--count", `${def}..${branch}`], repo) || "0");
			const behind = Number(sh("git", ["rev-list", "--count", `${branch}..${def}`], repo) || "0");
			out.push({ repo: e.name, branch, staleDays: DAYS(Number(ts) * 1000), ahead, behind, lastSubject: (rest.join("\t") || "").slice(0, 80) });
		}
	}
	return out.sort((a, b) => a.staleDays - b.staleDays);
}

// ---- 2. sessions ----
type SessionFinding = { project: string; branch: string; file: string; ageDays: number; preview: string };

function scanSessions(): SessionFinding[] {
	const root = path.join(HOME, ".claude", "projects");
	if (!fs.existsSync(root)) return [];
	const out: SessionFinding[] = [];
	for (const proj of fs.readdirSync(root)) {
		const dir = path.join(root, proj);
		let files: string[]; try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
		for (const f of files) {
			const fp = path.join(dir, f);
			let stat; try { stat = fs.statSync(fp); } catch { continue; }
			const age = DAYS(stat.mtimeMs);
			if (age > 30) continue; // only recent, else it's just history
			let lines: string[]; try { lines = fs.readFileSync(fp, "utf8").split("\n").filter(Boolean); } catch { continue; }
			// Walk from the end for the last REAL turn (user/assistant), grabbing the
			// session's cwd + branch along the way. Attachments/summaries are skipped.
			let cwd = "";
			let branch = "";
			let lastRole = "";
			let preview = "";
			for (let i = lines.length - 1; i >= 0; i--) {
				let j: any; try { j = JSON.parse(lines[i]); } catch { continue; }
				if (!cwd && j.cwd) cwd = String(j.cwd);
				if (!branch && j.gitBranch) branch = String(j.gitBranch);
				if (!lastRole && (j.type === "user" || j.type === "assistant")) {
					lastRole = j.type;
					const c = j.message?.content;
					preview = (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? "").join(" ") : "")
						.replace(/\s+/g, " ").slice(0, 110);
				}
				if (cwd && branch && lastRole) break;
			}
			// Unfinished = the human spoke last: the agent never replied / was interrupted.
			if (lastRole !== "user") continue;
			out.push({ project: (cwd || proj).replace(HOME, "~"), branch, file: f, ageDays: age, preview });
		}
	}
	return out.sort((a, b) => a.ageDays - b.ageDays);
}

export function runScan() {
	const branches = scanBranches();
	const sessions = scanSessions();
	return {
		scannedAt: new Date().toISOString(),
		branches: { total: branches.length, stale30: branches.filter((b) => b.staleDays > 30).length, items: branches },
		sessions: { total: sessions.length, items: sessions },
	};
}
export type ScanResult = ReturnType<typeof runScan>;

if (import.meta.main) {
	const result = runScan();
	process.stdout.write(JSON.stringify(result, null, 2));
	process.stderr.write(`\n[scan] ${result.branches.total} unfinished branches (${result.branches.stale30} stale>30d), ${result.sessions.total} unfinished sessions\n`);
}
