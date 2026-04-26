import { describe, test, expect, beforeEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { evaluatePolicy } from "./policy-engine";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coppa-test-"));
process.env.EIGHT_DATA_DIR = TMP_DIR;

describe("COPPA hard-deny", () => {
	test("blocks email_send for 8gent Jr product", () => {
		const decision = evaluatePolicy("email_send", {
			product: "8gentjr",
			account_age_verified_13_plus: true,
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.reason).toMatch(/coppa/i);
		}
	});

	test("blocks email_receive when age is unverified", () => {
		const decision = evaluatePolicy("email_receive", {
			account_age_verified_13_plus: false,
		});
		expect(decision.allowed).toBe(false);
	});

	test("blocks email_receive when age field is missing entirely", () => {
		const decision = evaluatePolicy("email_receive", {});
		expect(decision.allowed).toBe(false);
	});

	test("blocks issue_email_address for 8gent Jr regardless of age field", () => {
		const decision = evaluatePolicy("issue_email_address", {
			product: "8gentjr",
			account_age_verified_13_plus: true,
			username: "kid",
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.reason).toMatch(/Jr accounts are blocked/i);
		}
	});

	test("allows email_send for verified adult account", () => {
		const decision = evaluatePolicy("email_send", {
			account_age_verified_13_plus: true,
			product: "8gentos",
		});
		expect(decision.allowed).toBe(true);
	});

	test("does not interfere with non-email actions", () => {
		const decision = evaluatePolicy("write_file", {
			path: "/tmp/foo.txt",
			content: "hello",
			product: "8gentjr",
		});
		expect(decision.allowed).toBe(true);
	});

	test("COPPA decision contains diagnostic prefix", () => {
		const decision = evaluatePolicy("email_send", {
			product: "8gentjr",
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.reason).toMatch(/^\[coppa-hard-deny\]/);
		}
	});
});

describe("Inter-agent messaging policies", () => {
	test("blocks cross-user agent mail send", () => {
		const decision = evaluatePolicy("agent_mail_send", {
			cross_user: true,
			from_user: "james",
			to_user: "charles",
			account_age_verified_13_plus: true,
		});
		expect(decision.allowed).toBe(false);
	});

	test("requires approval for cross-channel agent mail", () => {
		const decision = evaluatePolicy("agent_mail_send", {
			cross_user: false,
			cross_channel: true,
			account_age_verified_13_plus: true,
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.requiresApproval).toBe(true);
		}
	});

	test("allows same-user same-channel agent mail", () => {
		const decision = evaluatePolicy("agent_mail_send", {
			cross_user: false,
			cross_channel: false,
			account_age_verified_13_plus: true,
		});
		expect(decision.allowed).toBe(true);
	});

	test("blocks reading another user's mailbox", () => {
		const decision = evaluatePolicy("agent_mail_read", {
			cross_user: true,
		});
		expect(decision.allowed).toBe(false);
	});

	test("blocks cross-user peer messages", () => {
		const decision = evaluatePolicy("peers_send", {
			cross_user: true,
		});
		expect(decision.allowed).toBe(false);
	});
});

describe("Email policies", () => {
	beforeEach(() => {});

	test("blocks email_send when hourly rate limit exceeded", () => {
		const decision = evaluatePolicy("email_send", {
			hourly_limit_exceeded: true,
			account_age_verified_13_plus: true,
		});
		expect(decision.allowed).toBe(false);
	});

	test("requires approval for bulk email", () => {
		const decision = evaluatePolicy("email_send", {
			bulk: true,
			account_age_verified_13_plus: true,
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.requiresApproval).toBe(true);
		}
	});

	test("blocks high spam-band inbound from agent context", () => {
		const decision = evaluatePolicy("email_receive", {
			spam_band: "high",
			account_age_verified_13_plus: true,
		});
		expect(decision.allowed).toBe(false);
	});

	test("blocks reserved username issuance", () => {
		const decision = evaluatePolicy("issue_email_address", {
			username: "admin",
			account_age_verified_13_plus: true,
		});
		expect(decision.allowed).toBe(false);
	});

	test("allows non-reserved username issuance for adult account", () => {
		const decision = evaluatePolicy("issue_email_address", {
			username: "james",
			account_age_verified_13_plus: true,
		});
		expect(decision.allowed).toBe(true);
	});
});
