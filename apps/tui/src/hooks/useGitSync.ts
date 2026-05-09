/**
 * useGitSync - poll `git rev-list` for ahead/behind counts vs upstream.
 *
 * Replaces the hardcoded "in sync" string in HeaderBar V2. Runs on a 30s
 * interval and on first mount. Failures (no repo, no upstream, detached
 * head) collapse to a sensible label so the chrome never throws.
 *
 * Pure async helper `computeGitSync` is exported separately so it can be
 * unit tested without React + without spawning a real subprocess (caller
 * injects a runner).
 */

import { useEffect, useState } from "react";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type GitSyncStatus =
	| "up-to-date"
	| "ahead"
	| "behind"
	| "diverged"
	| "detached"
	| "no-upstream"
	| "no-repo";

export interface GitSyncResult {
	status: GitSyncStatus;
	ahead: number;
	behind: number;
	label: string;
}

export type GitRunner = (
	args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

const defaultRunner: GitRunner = async (args) => {
	try {
		const out = await execFileAsync("git", args, { timeout: 5_000 });
		return { stdout: out.stdout, stderr: out.stderr, code: 0 };
	} catch (err: any) {
		return {
			stdout: err?.stdout ?? "",
			stderr: err?.stderr ?? "",
			code: typeof err?.code === "number" ? err.code : 1,
		};
	}
};

function buildLabel(branch: string, status: GitSyncStatus, ahead: number, behind: number): string {
	const head = branch || "head";
	switch (status) {
		case "up-to-date":
			return `${head}: up to date`;
		case "ahead":
			return `${head}: ${ahead} ahead`;
		case "behind":
			return `${head}: ${behind} behind`;
		case "diverged":
			return `${head}: diverged`;
		case "detached":
			return `${head}: detached`;
		case "no-upstream":
			return `${head}: no upstream`;
		case "no-repo":
			return "no repo";
	}
}

export async function computeGitSync(
	cwd: string,
	runner: GitRunner = defaultRunner,
): Promise<GitSyncResult> {
	const cwdArgs = ["-C", cwd];

	// Verify repo
	const repoCheck = await runner([...cwdArgs, "rev-parse", "--is-inside-work-tree"]);
	if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== "true") {
		return { status: "no-repo", ahead: 0, behind: 0, label: buildLabel("", "no-repo", 0, 0) };
	}

	// Branch name
	const branchOut = await runner([...cwdArgs, "rev-parse", "--abbrev-ref", "HEAD"]);
	const branch = branchOut.stdout.trim();

	if (branch === "HEAD") {
		return { status: "detached", ahead: 0, behind: 0, label: buildLabel(branch, "detached", 0, 0) };
	}

	// Counts. `git rev-list --left-right --count @{u}...HEAD` returns "behind\tahead".
	// We use the explicit two-arg form for clarity even though it spawns twice.
	const aheadOut = await runner([...cwdArgs, "rev-list", "--count", "@{u}..HEAD"]);
	if (aheadOut.code !== 0) {
		return {
			status: "no-upstream",
			ahead: 0,
			behind: 0,
			label: buildLabel(branch, "no-upstream", 0, 0),
		};
	}
	const behindOut = await runner([...cwdArgs, "rev-list", "--count", "HEAD..@{u}"]);
	if (behindOut.code !== 0) {
		return {
			status: "no-upstream",
			ahead: 0,
			behind: 0,
			label: buildLabel(branch, "no-upstream", 0, 0),
		};
	}

	const ahead = Number(aheadOut.stdout.trim()) || 0;
	const behind = Number(behindOut.stdout.trim()) || 0;

	let status: GitSyncStatus;
	if (ahead === 0 && behind === 0) status = "up-to-date";
	else if (ahead > 0 && behind === 0) status = "ahead";
	else if (ahead === 0 && behind > 0) status = "behind";
	else status = "diverged";

	return { status, ahead, behind, label: buildLabel(branch, status, ahead, behind) };
}

export function useGitSync(
	cwd: string,
	intervalMs = 30_000,
	enabled = true,
): GitSyncResult {
	const [result, setResult] = useState<GitSyncResult>({
		status: "up-to-date",
		ahead: 0,
		behind: 0,
		label: "checking",
	});

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		const run = async () => {
			try {
				const r = await computeGitSync(cwd);
				if (!cancelled) setResult(r);
			} catch {
				/* swallow - keep last good label */
			}
		};
		void run();
		const id = setInterval(run, intervalMs);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [cwd, intervalMs, enabled]);

	return result;
}
