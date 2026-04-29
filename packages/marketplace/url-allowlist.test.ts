import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isAllowedArchiveUrl } from "./url-allowlist";

describe("isAllowedArchiveUrl", () => {
	const previousEnv = process.env.EIGHT_ARCHIVE_ALLOWLIST;

	beforeEach(() => {
		delete process.env.EIGHT_ARCHIVE_ALLOWLIST;
	});

	afterEach(() => {
		if (previousEnv === undefined) {
			delete process.env.EIGHT_ARCHIVE_ALLOWLIST;
		} else {
			process.env.EIGHT_ARCHIVE_ALLOWLIST = previousEnv;
		}
	});

	it("accepts 8gi-foundation GitHub source", () => {
		expect(
			isAllowedArchiveUrl(
				"https://github.com/8gi-foundation/8gent-code/archive/refs/tags/v1.0.0.tar.gz",
			),
		).toBe(true);
	});

	it("accepts foundation CDN", () => {
		expect(isAllowedArchiveUrl("https://cdn.8gent.dev/apps/demo-1.0.0.8gent-app.tar.gz")).toBe(
			true,
		);
	});

	it("accepts GitHub release artifacts", () => {
		expect(
			isAllowedArchiveUrl(
				"https://objects.githubusercontent.com/github-production-release-asset/abc/def",
			),
		).toBe(true);
	});

	it("rejects non-HTTPS URLs", () => {
		expect(isAllowedArchiveUrl("http://github.com/8gi-foundation/8gent-code/x.tar.gz")).toBe(
			false,
		);
	});

	it("rejects URLs with credentials", () => {
		expect(
			isAllowedArchiveUrl("https://u:p@github.com/8gi-foundation/8gent-code/x.tar.gz"),
		).toBe(false);
	});

	it("rejects unrelated GitHub orgs", () => {
		expect(isAllowedArchiveUrl("https://github.com/some-other-org/repo/x.tar.gz")).toBe(false);
	});

	it("rejects unrelated hosts", () => {
		expect(isAllowedArchiveUrl("https://evil.example.com/x.tar.gz")).toBe(false);
	});

	it("permits localhost over HTTP for local dev", () => {
		expect(isAllowedArchiveUrl("http://localhost:8080/x.tar.gz")).toBe(true);
	});

	it("respects EIGHT_ARCHIVE_ALLOWLIST extension", () => {
		process.env.EIGHT_ARCHIVE_ALLOWLIST = "registry.example.com";
		expect(isAllowedArchiveUrl("https://registry.example.com/apps/x.tar.gz")).toBe(true);
	});

	it("rejects malformed URLs", () => {
		expect(isAllowedArchiveUrl("not a url")).toBe(false);
	});
});
