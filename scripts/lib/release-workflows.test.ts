/**
 * Structural guarantees of the release workflows (#3981), read from the YAML
 * itself so a later edit cannot quietly undo them:
 *   - only the `attest` job of release-binaries.yml can mint an OIDC token or
 *     write attestations, and it runs no repository or dependency code;
 *   - the release is not published before the attestation exists;
 *   - every checkout drops its credentials; every action is pinned to a SHA.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
	for (const f of [
		"release.yml",
		"release-binaries.yml",
		"release-pr.yml",
		"release-install-smoke.yml",
	]) {
		const wf = load(f);
		test(`${f}: every action is pinned to a commit SHA`, () => {
			for (const job of Object.values(wf.jobs)) {
				for (const s of job.steps ?? []) {
					if (s.uses && !s.uses.startsWith("./")) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
				}
			}
		});
		if (f !== "release-install-smoke.yml" && f !== "release-pr.yml") {
			test(`${f}: every checkout drops its credentials`, () => {
				for (const job of Object.values(wf.jobs)) {
					for (const s of job.steps ?? []) {
						if ((s.uses ?? "").startsWith("actions/checkout@"))
							expect(s.with?.["persist-credentials"]).toBe(false);
					}
				}
			});
		}
	}

	test("release.yml: id-token only on the publishing job", () => {
		const wf = load("release.yml");
		expect(wf.permissions).toEqual({});
		expect(wf.jobs.release.permissions?.["id-token"]).toBe("write");
		expect(wf.jobs.alarm.permissions?.["id-token"]).toBeUndefined();
	});
});
