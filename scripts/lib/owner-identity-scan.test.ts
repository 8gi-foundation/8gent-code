import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	builderIdentities,
	collectOwnerIdentities,
	envIdentities,
	findOwnerIdentity,
	identitiesFromAuthorLog,
	isScannableIdentity,
	maskIdentity,
	repoAuthorIdentities,
} from "./owner-identity-scan";

const ROOT = join(import.meta.dir, "..", "..");

describe("owner-identity scan - identity collection", () => {
	test("keeps full names and real emails, drops bots, no-reply and single words", () => {
		const log = [
			"Ada Quill\x00ada.quill@example.test",
			"github-actions[bot]\x0041898282+github-actions[bot]@users.noreply.github.com",
			"adaq\x00123+adaq@users.noreply.github.com",
			"Claude\x00",
		].join("\n");
		expect(identitiesFromAuthorLog(log).sort()).toEqual(["Ada Quill", "ada.quill@example.test"]);
		expect(isScannableIdentity("Bo")).toBe(false);
	});

	test("env identities are comma separated and filtered", () => {
		expect(envIdentities(" Ada Quill , x , ada@example.test")).toEqual([
			"Ada Quill",
			"ada@example.test",
		]);
		expect(envIdentities(undefined)).toEqual([]);
	});

	test("matches names exactly and emails case-insensitively", () => {
		const src = `const A = "Ada Quill"; const B = "ADA@EXAMPLE.TEST"; const C = "ada quill";`;
		expect(findOwnerIdentity(src, ["Ada Quill", "ada@example.test", "Bo Tanaka"])).toEqual([
			"Ada Quill",
			"ada@example.test",
		]);
	});

	test("masks values for logs", () => {
		expect(maskIdentity("Ada Quill")).toBe("Ad***");
		expect(maskIdentity("ada@example.test")).toBe("ad***@example.test");
	});
});

describe("owner-identity scan - the shipped anonymizer", () => {
	test("bundling the PII anonymizer bakes in no commit author's name or email", async () => {
		const identities = repoAuthorIdentities(ROOT);
		// The checkout must have at least one author for the gate to mean anything.
		expect(identities.length).toBeGreaterThan(0);

		const built = await Bun.build({
			entrypoints: [join(ROOT, "packages", "permissions", "pii-anonymizer.ts")],
			target: "bun",
		});
		expect(built.success).toBe(true);
		const src = await built.outputs[0].text();
		expect(findOwnerIdentity(src, identities).map(maskIdentity)).toEqual([]);
	});
});

describe("owner-identity scan - identities that are not commit authors", () => {
	// A bundle that hardcodes only an email (as v0.18.0 did) or only a surname.
	const BUNDLE = `var OWNER = [{ value: "ada.quill@example.test", type: "EMAIL" }], T = ["Quill"];`;
	const isolatedGit = (home: string): NodeJS.ProcessEnv => ({
		...process.env,
		HOME: home,
		GIT_CONFIG_GLOBAL: join(home, "none.gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		PACK_SMOKE_OWNER_IDENTITY: "",
	});

	test("an email-only identity from PACK_SMOKE_OWNER_IDENTITY is caught", () => {
		const home = mkdtempSync(join(tmpdir(), "8gent-owner-scan-"));
		try {
			expect(repoAuthorIdentities(ROOT)).not.toContain("ada.quill@example.test");
			const env = { ...isolatedGit(home), PACK_SMOKE_OWNER_IDENTITY: "ada.quill@example.test" };
			const ids = collectOwnerIdentities({ root: ROOT, home, env });
			expect(findOwnerIdentity(BUNDLE, ids)).toEqual(["ada.quill@example.test"]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a bare surname from PACK_SMOKE_OWNER_IDENTITY is caught as a whole word only", () => {
		const ids = envIdentities("Quill");
		expect(findOwnerIdentity(BUNDLE, ids)).toEqual(["Quill"]);
		expect(findOwnerIdentity(`var q = "Quillon";`, ids)).toEqual([]);
	});

	test("the building user's git email and name are scanned", () => {
		const repo = mkdtempSync(join(tmpdir(), "8gent-owner-scan-repo-"));
		try {
			const env = isolatedGit(repo);
			spawnSync("git", ["init", "-q"], { cwd: repo, env });
			spawnSync("git", ["config", "user.email", "ada.quill@example.test"], { cwd: repo, env });
			spawnSync("git", ["config", "user.name", "Quill"], { cwd: repo, env });
			expect(builderIdentities(repo, env).sort()).toEqual(["Quill", "ada.quill@example.test"]);
			// The repo has no commits, so neither value is a commit author.
			const ids = collectOwnerIdentities({ root: repo, home: repo, env });
			expect(findOwnerIdentity(BUNDLE, ids).sort()).toEqual(["Quill", "ada.quill@example.test"]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
