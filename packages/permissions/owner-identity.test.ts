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

	test("single-word git names are never bare-masked (admin, ubuntu, Grace)", () => {
		for (const name of ["admin", "ubuntu", "Grace"]) {
			setGitConfig({ name });
			expect(anonymize(`ask ${name} first`).text).toBe(`ask ${name} first`);
		}
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

	test('a git name like "GitHub Actions" or "Ubuntu User" masks only the full name', () => {
		for (const name of ["GitHub Actions", "Ubuntu User"]) {
			setGitConfig({ name });
			const [first, last] = name.split(" ");
			expect(anonymize(`${name} ran it`).text).not.toContain(name);
			expect(anonymize(`the ${last} tab, ${first} box`).text).toBe(`the ${last} tab, ${first} box`);
		}
	});

	test("a git full name keeps a non-common surname masked", () => {
		setGitConfig({ name: "Will Smith" });
		expect(anonymize("Smith says hi").text).not.toContain("Smith");
	});
});
