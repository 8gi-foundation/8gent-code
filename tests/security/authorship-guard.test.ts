/**
 * Finding: the authorship guard (scripts/check-authorship.sh) must flag only
 * the commits a PR itself introduces, judged by identity and trailers, never
 * by prose. 8gent-dev #126 diffed origin/main..HEAD on a stale shallow
 * checkout and failed a clean PR over vendor commits already on main.
 *
 * Each test builds a throwaway git repo; no network.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/check-authorship.sh");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const GOOD = { name: "James Spalding", email: "podjamz@gmail.com" };
const VENDOR = { name: "Claude", email: "noreply@anthropic.com" };

function sh(cwd: string, cmd: string, env: Record<string, string> = {}) {
	const p = Bun.spawnSync(["bash", "-c", cmd], {
		cwd,
		env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", ...env },
	});
	return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

function repo() {
	const d = mkdtempSync(join(tmpdir(), "authorship-"));
	dirs.push(d);
	sh(d, "git init -q -b main");
	return d;
}

function commit(
	d: string,
	msg: string,
	who = GOOD,
	committer = who,
): string {
	writeFileSync(join(d, "f.txt"), `${Math.random()}\n`);
	writeFileSync(join(d, ".msg"), msg);
	sh(
		d,
		"git add f.txt && git commit -q -F .msg",
		{
			GIT_AUTHOR_NAME: who.name,
			GIT_AUTHOR_EMAIL: who.email,
			GIT_COMMITTER_NAME: committer.name,
			GIT_COMMITTER_EMAIL: committer.email,
		},
	);
	return sh(d, "git rev-parse HEAD").out.trim();
}

/** main has a base commit, then the PR branch forks from it. */
function pr(d: string) {
	const base = commit(d, "base");
	sh(d, "git checkout -q -b pr");
	return base;
}

const run = (d: string, base: string) => sh(d, `bash ${SCRIPT}`, { BASE_SHA: base });

describe("authorship guard", () => {
	test("a clean PR passes", () => {
		const d = repo();
		const base = pr(d);
		commit(d, "feat: add thing\n\nBody text.");
		const r = run(d, base);
		expect(r.code).toBe(0);
		expect(r.out).toContain("authorship clean");
	});

	test("a vendor author fails", () => {
		const d = repo();
		const base = pr(d);
		commit(d, "feat: add thing", VENDOR);
		const r = run(d, base);
		expect(r.code).toBe(1);
		expect(r.out).toContain("author or committer");
	});

	test("a vendor committer fails", () => {
		const d = repo();
		const base = pr(d);
		commit(d, "feat: add thing", GOOD, VENDOR);
		expect(run(d, base).code).toBe(1);
	});

	test("a vendor Co-Authored-By trailer fails", () => {
		const d = repo();
		const base = pr(d);
		commit(d, "feat: add thing\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>");
		const r = run(d, base);
		expect(r.code).toBe(1);
		expect(r.out).toContain("Co-Authored-By");
	});

	test("a Claude-Session trailer fails", () => {
		const d = repo();
		const base = pr(d);
		commit(d, "feat: add thing\n\nClaude-Session: https://claude.ai/code/session_x");
		expect(run(d, base).code).toBe(1);
	});

	test("a Generated with trailer naming a vendor fails", () => {
		const d = repo();
		const base = pr(d);
		commit(d, "feat: add thing\n\nGenerated with Claude Code");
		expect(run(d, base).code).toBe(1);
	});

	test("a human Co-Authored-By trailer passes", () => {
		const d = repo();
		const base = pr(d);
		commit(d, "feat: add thing\n\nCo-Authored-By: Artale <artale@example.com>");
		expect(run(d, base).code).toBe(0);
	});

	test("prose that mentions a vendor passes", () => {
		const d = repo();
		const base = pr(d);
		commit(
			d,
			"docs: explain the guard\n\nIt rejects commits attributed to Claude or OpenAI, and a\nCo-Authored-By: line naming noreply@anthropic.com. We discuss Anthropic here,\nwe are not attributed to it.",
		);
		expect(run(d, base).code).toBe(0);
	});

	test("vendor commits already on main, outside the PR range, are ignored", () => {
		const d = repo();
		commit(d, "old\n\nCo-Authored-By: Claude <noreply@anthropic.com>", VENDOR);
		const staleBase = commit(d, "base");
		// PR forks here.
		sh(d, "git checkout -q -b pr");
		commit(d, "feat: clean pr work");
		// Meanwhile main moves on with more vendor commits, then is merged into the PR.
		sh(d, "git checkout -q main");
		const newBase = commit(d, "main moved\n\nClaude-Session: x", VENDOR);
		sh(d, "git checkout -q pr");
		sh(d, `git merge -q --no-ff -m "Merge main into pr" ${newBase}`, {
			GIT_AUTHOR_NAME: GOOD.name,
			GIT_AUTHOR_EMAIL: GOOD.email,
			GIT_COMMITTER_NAME: GOOD.name,
			GIT_COMMITTER_EMAIL: GOOD.email,
		});
		// Stale base sha (the old fork point) must still not pull in main's vendor commits
		// via the merge-base only when the base is the PR base from the event.
		expect(run(d, newBase).code).toBe(0);
		expect(staleBase).toBeTruthy();
	});

	test("a vendor commit inside the PR range still fails when main has moved", () => {
		const d = repo();
		const base = pr(d);
		commit(d, "feat: bad", VENDOR);
		sh(d, "git checkout -q main");
		const newBase = commit(d, "main moved");
		sh(d, "git checkout -q pr");
		expect(run(d, newBase).code).toBe(1);
		expect(base).toBeTruthy();
	});

	test("a shallow clone is deepened to find the merge base", () => {
		const d = repo();
		const base = pr(d);
		commit(d, "feat: one");
		commit(d, "feat: two");
		commit(d, "feat: three");
		const clone = mkdtempSync(join(tmpdir(), "authorship-clone-"));
		dirs.push(clone);
		sh(clone, `git clone -q --depth 1 file://${d} . && git checkout -q pr`);
		sh(clone, "git remote -v");
		const r = run(clone, base);
		expect(r.code).toBe(0);
		expect(r.out).toContain("authorship clean");
	});

	test("an unresolvable HEAD_SHA exits 2, never clean", () => {
		const d = repo();
		const base = pr(d);
		commit(d, "feat: x");
		const r = sh(d, `bash ${SCRIPT}`, { BASE_SHA: base, HEAD_SHA: "deadbeef" });
		expect(r.code).toBe(2);
		expect(r.out).not.toContain("authorship clean");
	});

	test("a root-commit push checks that commit", () => {
		const bad = repo();
		commit(bad, "root", VENDOR);
		expect(sh(bad, `bash ${SCRIPT}`).code).toBe(1);
		const ok = repo();
		commit(ok, "root");
		expect(sh(ok, `bash ${SCRIPT}`).code).toBe(0);
	});
});
