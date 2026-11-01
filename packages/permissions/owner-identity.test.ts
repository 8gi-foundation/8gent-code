/**
 * The anonymizer protects the person running 8gent, read at runtime from
 * their own profile and git config, and nobody else. Each test runs against an
 * isolated HOME and git config so the developer's machine never leaks in.
 *
 * These import only the anonymizer's public API, so they exercise the same
 * path the cloud-egress chokepoint uses.
 */
import { describe, expect, test } from "bun:test";
import { isolateOwnerIdentity } from "./__tests__/isolated-owner-identity";
import { anonymize, containsPii, deanonymize } from "./pii-anonymizer";

const { setProfileName, setGitConfig } = isolateOwnerIdentity();

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

	test("a mid-session git config --global change is picked up without a restart", () => {
		setGitConfig({ name: "Bo Tanaka" });
		expect(anonymize("ask Tanaka").text).not.toContain("Tanaka");

		setGitConfig({ name: "Cyd Marlowe" });
		expect(anonymize("ask Marlowe").text).not.toContain("Marlowe");
		expect(anonymize("ask Tanaka").text).toBe("ask Tanaka");
	});

	test("the configured owner is the only owner", () => {
		setProfileName("Ada Quill");
		expect(anonymize("ask James").text).toBe("ask James");
	});
});

describe("owner identity - no over-redaction", () => {
	test('a git user.name of "root" masks nothing ordinary', () => {
		setGitConfig({ name: "root" });
		const text = "cd /root/app and run it as root";
		expect(anonymize(text).text).toBe(text);
		expect(containsPii(text)).toBe(false);
	});

	test("a single-word git name is never bare-masked (admin)", () => {
		setGitConfig({ name: "admin" });
		expect(anonymize("ask admin first").text).toBe("ask admin first");
	});

	test("a single-word git name is never bare-masked (ubuntu)", () => {
		setGitConfig({ name: "ubuntu" });
		expect(anonymize("ask ubuntu first").text).toBe("ask ubuntu first");
	});

	test("a single-word git name is never bare-masked (Grace)", () => {
		setGitConfig({ name: "Grace" });
		expect(anonymize("ask Grace first").text).toBe("ask Grace first");
	});

	test('"Will Smith" masks the full name and the surname, not "Will this work?"', () => {
		setGitConfig({ name: "Will Smith" });
		const r = anonymize("Will Smith wrote it. Smith says hi.");
		expect(r.text).not.toContain("Will Smith");
		expect(r.text).not.toMatch(/\bSmith\b/);
		expect(anonymize("Will this work?").text).toBe("Will this work?");
		expect(containsPii("Will this work?")).toBe(false);
	});

	test("name words shorter than 3 characters are not bare-masked", () => {
		setProfileName("Bo Li");
		expect(anonymize("Bo Li shipped it").text).not.toContain("Bo Li");
		expect(anonymize("go to Li or Bo").text).toBe("go to Li or Bo");
	});
});

describe("owner identity - accented names", () => {
	test("bare accented names are masked as whole words", () => {
		setProfileName("José Ólafsson");
		const r = anonymize("José asked Ólafsson to review.");
		expect(r.text).not.toContain("José");
		expect(r.text).not.toContain("Ólafsson");
		expect(containsPii("ping José")).toBe(true);
		expect(containsPii("ping Ólafsson")).toBe(true);
		// Not inside a longer accented word.
		expect(anonymize("Joséphine").text).toBe("Joséphine");
	});
});

describe("owner identity - one-word names and account-like git names", () => {
	test("a one-word profile name is bare-masked unless it is a common word (intended)", () => {
		setProfileName("Ada");
		expect(anonymize("ask Ada").text).not.toContain("Ada");
		// By design: a one-word profile name that is a common word gets no bare
		// protection, so ordinary sentences survive.
		setProfileName("Will", 1_700_000_200);
		expect(anonymize("Will this work?").text).toBe("Will this work?");
		expect(containsPii("Will this work?")).toBe(false);
	});

	test('a git name like "GitHub Actions" masks only the full name', () => {
		setGitConfig({ name: "GitHub Actions" });
		expect(anonymize("GitHub Actions ran it").text).not.toContain("GitHub Actions");
		expect(anonymize("the Actions tab, GitHub box").text).toBe("the Actions tab, GitHub box");
	});

	test('a git name like "Ubuntu User" masks only the full name', () => {
		setGitConfig({ name: "Ubuntu User" });
		expect(anonymize("Ubuntu User ran it").text).not.toContain("Ubuntu User");
		expect(anonymize("the User tab, Ubuntu box").text).toBe("the User tab, Ubuntu box");
	});

	test("a git full name keeps a non-common surname masked", () => {
		setGitConfig({ name: "Will Smith" });
		expect(anonymize("Smith says hi").text).not.toContain("Smith");
	});
});
