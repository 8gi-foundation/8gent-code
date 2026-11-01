/**
 * Structural guarantees of the release workflows (#3981), read from the YAML
 * itself so a later edit cannot quietly undo them:
 *   - only the `attest` job of release-binaries.yml can mint an OIDC token or
 *     write attestations, and it runs no repository or dependency code;
 *   - the release is not published before the attestation exists;
 *   - every checkout drops its credentials; every action is pinned to a SHA.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const WF = join(import.meta.dir, "..", "..", ".github", "workflows");
type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { permissions?: Record<string, string>; needs?: string | string[]; steps?: Step[] };
const load = (f: string) =>
	parse(readFileSync(join(WF, f), "utf8")) as {
		permissions?: Record<string, string>;
		jobs: Record<string, Job>;
	};

describe("release-binaries.yml", () => {
	const wf = load("release-binaries.yml");

	test("only the attest job holds id-token or attestations write", () => {
		expect(wf.permissions?.["id-token"]).toBeUndefined();
		const holders = Object.entries(wf.jobs)
			.filter(
				([, j]) =>
					j.permissions?.["id-token"] === "write" || j.permissions?.attestations === "write",
			)
			.map(([name]) => name);
		expect(holders).toEqual(["attest"]);
	});

	test("the attest job runs no code: no run steps, no checkout, only pinned download + attest", () => {
		const steps = wf.jobs.attest.steps ?? [];
		expect(steps.some((s) => s.run)).toBe(false);
		const uses = steps.map((s) => (s.uses ?? "").split("@")[0]);
		expect(uses).toEqual(["actions/download-artifact", "actions/attest-build-provenance"]);
		expect(wf.jobs.attest.needs).toBe("build");
	});

	test("the build job (which runs bun install) cannot attest", () => {
		const build = wf.jobs.build;
		expect(build.permissions).toEqual({ contents: "read" });
		expect((build.steps ?? []).some((s) => (s.uses ?? "").startsWith("actions/attest"))).toBe(
			false,
		);
		expect((build.steps ?? []).some((s) => /bun install/.test(s.run ?? ""))).toBe(true);
	});

	test("the release is published only after the attestation", () => {
		expect(wf.jobs.release.needs).toContain("attest");
	});
});

describe("all release workflows", () => {
	// Every workflow file, not four named ones. The old list is the enumeration
	// that let release-proxy.yml carry 8 movable refs unchecked while four sibling
	// release workflows were verified. #4149 pinned the last of them, so the
	// property now holds everywhere and the list can stop being hand-maintained.
	// Job-level `uses:` (a reusable workflow) is checked too: a remote one on a
	// movable tag is the same hole as a step. Local `./` refs live in this repo.
	for (const f of readdirSync(WF).filter((n) => /\.ya?ml$/.test(n))) {
		const wf = load(f);
		test(`${f}: every action is pinned to a commit SHA`, () => {
			for (const job of Object.values(wf.jobs) as (Job & { uses?: string })[]) {
				for (const ref of [job.uses, ...(job.steps ?? []).map((s) => s.uses)]) {
					if (ref && !ref.startsWith("./")) expect(ref).toMatch(/@[0-9a-f]{40}$/);
				}
			}
		});
	}

	// Not every workflow yet: 15 of the 20 do not set persist-credentials: false,
	// so widening this would fail rather than enforce. The two the old loop
	// excluded - release-pr.yml (1 of 4 set) and release-install-smoke.yml (0 of
	// 4) - are two of those 15; their exclusion was an accommodation, not a
	// policy. These two comply. Add to this list as others are fixed; do not
	// delete the assertion to make room for a file.
	for (const f of ["release.yml", "release-binaries.yml"]) {
		const wf = load(f);
		test(`${f}: every checkout drops its credentials`, () => {
			for (const job of Object.values(wf.jobs)) {
				for (const s of job.steps ?? []) {
					if ((s.uses ?? "").startsWith("actions/checkout@"))
						expect(s.with?.["persist-credentials"]).toBe(false);
				}
			}
		});
	}

	test("release.yml: id-token only on the publishing job", () => {
		const wf = load("release.yml");
		expect(wf.permissions).toEqual({});
		expect(wf.jobs.release.permissions?.["id-token"]).toBe("write");
		expect(wf.jobs.alarm.permissions?.["id-token"]).toBeUndefined();
	});

	// #3658: the repository has no PACK_SMOKE_OWNER_IDENTITY secret, and the
	// pack smoke scans every commit author without it. A release must never
	// fail on that secret being absent; the smoke requires it only when set.
	test("release.yml: PACK_SMOKE_OWNER_IDENTITY is optional", () => {
		const wf = load("release.yml");
		const steps = wf.jobs.release.steps ?? [];
		const preflight = steps.find((s) => /Preflight/.test(String((s as { name?: string }).name)));
		expect(preflight?.run).toBeDefined();
		expect(preflight?.run).not.toMatch(/PACK_SMOKE_OWNER_IDENTITY[^\n]*\n[^\n]*\n\s*exit 1/);
		const smoke = steps.find((s) => /pack-smoke\.ts/.test(s.run ?? ""));
		const env = (smoke as { env?: Record<string, string> } | undefined)?.env ?? {};
		expect(env.PACK_SMOKE_REQUIRE_OWNER_IDENTITY).not.toBe("1");
		expect(env.PACK_SMOKE_REQUIRE_OWNER_IDENTITY).toContain(
			"secrets.PACK_SMOKE_OWNER_IDENTITY != ''",
		);
	});

	// #3658: npm latest sat at 0.17.0 for five months with no issue. A release
	// whose npm channel was skipped or failed must reach the alarm job.
	test("release.yml: the alarm job fires when the npm channel did not publish", () => {
		const wf = load("release.yml");
		const outputs = (wf.jobs.release as { outputs?: Record<string, string> }).outputs ?? {};
		expect(outputs.npm).toContain("steps.npm.outputs.npm");
		const steps = wf.jobs.release.steps ?? [];
		const ids = steps.map((s) => (s as { id?: string }).id);
		expect(ids).toContain("npm_publish");
		expect(ids).toContain("npm_latest");
		expect(ids).toContain("npm");
		const alarm = wf.jobs.alarm as Job & { if?: string };
		expect(alarm.needs).toBe("release");
		expect(alarm.if).toContain("needs.release.result == 'failure'");
		expect(alarm.if).toContain("needs.release.outputs.npm != 'published'");
		expect(alarm.if).not.toMatch(/^\s*failure\(\)/);
		const step = (alarm.steps ?? []).find((s) => /release-alarm\.sh/.test(s.run ?? ""));
		expect(step?.run).toContain('"release.yml npm channel"');
	});
});

// #4700: `npm publish release-assets/x.tgz` made npm run git ls-remote on
// github.com/release-assets/x.tgz.git, and v0.20.10 never reached npm. A tarball
// or folder argument with a slash must be absolute or start with ./ or ../.
describe("npm tarball paths (#4700)", () => {
	const bareShorthand = (line: string) => {
		const m = line.match(/\bnpm\s+(?:publish|i|install)\b(.*)$/);
		if (!m) return false;
		return m[1]
			.trim()
			.split(/\s+/)
			.filter((a) => a && !a.startsWith("-"))
			.map((a) => a.replace(/^["']|["']$/g, ""))
			.some(
				(a) => /^[A-Za-z0-9_.-]+\/[^\s]*$/.test(a) && !a.startsWith("@") && !/^\.\.?\//.test(a),
			);
	};

	test("the shorthand check catches the v0.20.10 line and passes the fixed forms", () => {
		expect(bareShorthand("npm publish release-assets/*.tgz --access public --provenance")).toBe(
			true,
		);
		expect(bareShorthand('npm publish "$TGZ" --access public --provenance')).toBe(false);
		expect(bareShorthand("npm publish ./release-assets/x.tgz")).toBe(false);
		expect(bareShorthand('npm i -g --prefix "$X" @8gi-foundation/8gent-code@1.0.0')).toBe(false);
	});

	test("no workflow passes a bare dir/file argument to npm publish or install", () => {
		const bad: string[] = [];
		for (const f of readdirSync(WF).filter((n) => /\.ya?ml$/.test(n))) {
			readFileSync(join(WF, f), "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (!line.trim().startsWith("#") && bareShorthand(line))
						bad.push(`${f}:${i + 1}: ${line.trim()}`);
				});
		}
		expect(bad).toEqual([]);
	});

	test("release.yml: a failed npm publish with auth fails the run; no auth stays green", () => {
		const steps = (load("release.yml").jobs.release.steps ?? []) as (Step & {
			if?: string;
			name?: string;
		})[];
		const fail = steps.at(-1);
		expect(fail?.if).toBe("steps.npm.outputs.npm == 'failed'");
		expect(fail?.run).toContain("exit 1");
		expect(steps.find((s) => (s as { id?: string }).id === "npm_publish")?.run).toContain(
			'npm publish "$TGZ"',
		);
	});

	test("release.yml: npm-from-release runs from main only and runs no repository code", () => {
		const job = load("release.yml").jobs["npm-from-release"] as Job & { if?: string };
		expect(job.if).toContain("github.ref == 'refs/heads/main'");
		expect(job.if).toContain("inputs.npm_only_tag != ''");
		expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
		const steps = job.steps ?? [];
		expect(steps.some((s) => (s.uses ?? "").startsWith("actions/checkout"))).toBe(false);
		const run = steps.map((s) => s.run ?? "").join("\n");
		expect(run).toContain("sha256sum -c want");
		expect(run).toContain('npm publish "$DIR/$NAME"');
		// 8SO: an unreadable dist-tag latest must stop the run, never skip the
		// "do not move latest backwards" check.
		expect(run).toContain("could not read npm dist-tag latest");
		expect(run).not.toContain('if [ -n "$LATEST" ] &&');
	});
});
