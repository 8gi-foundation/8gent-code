/**
 * The anonymizer protects the person running 8gent, read at runtime from
 * their own profile and git config, and nobody else. Each test runs against an
 * isolated HOME and git config so the developer's machine never leaks in.
 *
 * These import only the anonymizer's public API, so they exercise the same
 * path the cloud-egress chokepoint uses.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anonymize, containsPii, deanonymize } from "./pii-anonymizer";

const ENV_KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "XDG_CONFIG_HOME"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let home = "";

function setProfileName(name: string, mtimeSec?: number): void {
	const dir = join(home, ".8gent");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "user.json");
	writeFileSync(file, JSON.stringify({ identity: { name } }));
	if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
}

function setGitConfig(user: { name?: string; email?: string }): void {
	const lines = ["[user]"];
	if (user.name) lines.push(`\tname = ${user.name}`);
	if (user.email) lines.push(`\temail = ${user.email}`);
	writeFileSync(join(home, "isolated.gitconfig"), `${lines.join("\n")}\n`);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "8gent-owner-identity-"));
	process.env.HOME = home;
	process.env.GIT_CONFIG_GLOBAL = join(home, "isolated.gitconfig");
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.XDG_CONFIG_HOME = join(home, ".config");
	writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("owner identity - no configured owner", () => {
	test("no maintainer name is redacted or special-cased", () => {
		const text = "ask James about the Spalding fork";
		const r = anonymize(text);
		expect(r.text).toBe(text);
		expect(r.count).toBe(0);
		expect(containsPii("ask James about it")).toBe(false);
		expect(containsPii("the Spalding fork")).toBe(false);
	});

	test("a bare first name passes through untouched", () => {
		expect(anonymize("Ada reviewed it").text).toBe("Ada reviewed it");
	});
});

describe("owner identity - configured owner", () => {
	test("the profile name and git email are protected", () => {
		setProfileName("Ada Quill");
		setGitConfig({ email: "ada.quill@example.test" });

		const raw = "Ada Quill wrote this. Ada said Quill signs as ada.quill@example.test.";
		const r = anonymize(raw);
		expect(r.text).not.toMatch(/\bAda\b/);
		expect(r.text).not.toMatch(/\bQuill\b/);
		expect(r.text).not.toContain("ada.quill@example.test");
		expect(containsPii("ping Ada")).toBe(true);
		expect(containsPii("ping Quill")).toBe(true);
		// Reversible for the user.
		expect(deanonymize(r.text, r.map)).toBe(raw);
	});

	test("the owner's name inside a longer word is not mangled", () => {
		setProfileName("Ada Quill");
		expect(anonymize("adamant quills").text).toBe("adamant quills");
	});

	test("with no profile name, git config user.name is the owner", () => {
		setGitConfig({ name: "Bo Tanaka" });
		const r = anonymize("ask Tanaka");
		expect(r.text).not.toContain("Tanaka");
		expect(containsPii("ask Tanaka")).toBe(true);
	});

	test("a name given during onboarding is picked up without a restart", () => {
		setProfileName("Ada Quill", 1_700_000_000);
		expect(anonymize("ask Ada").text).not.toContain("Ada");

		setProfileName("Cyd Marlow", 1_700_000_100);
		expect(anonymize("ask Cyd").text).not.toContain("Cyd");
		expect(anonymize("ask Ada").text).toBe("ask Ada");
	});

	test("the configured owner is the only owner", () => {
		setProfileName("Ada Quill");
		expect(anonymize("ask James").text).toBe("ask James");
	});
});
