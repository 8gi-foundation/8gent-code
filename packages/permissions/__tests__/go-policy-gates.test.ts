/**
 * Tests for /goal policy gates (issue #2609, epic #2605).
 *
 * Covers:
 *   - CapabilityBudget axis exhaustion (each axis independently)
 *   - Cloud-with-secrets hard block
 *   - Deny-list pattern coverage (every class)
 *   - Secret scrub regex coverage (every pattern)
 *   - HMAC sign/verify roundtrip + tamper detection
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	type BudgetCounters,
	type CapabilityBudget,
	DEFAULT_COMPUTER_USE_BUDGET,
	DEFAULT_TUI_BUDGET,
	evaluateBudget,
} from "../policy-engine";
import { GO_DENY_LIST, matchDenyList } from "../go-deny-list";
import { containsSecret, scrubGoalText, SECRET_PATTERNS } from "../goal-secret-scrub";
import {
	loadOrCreateKey,
	sign as signState,
	verify as verifyState,
	verifyOrThrow,
} from "../goal-state-hmac";

// ============================================
// CapabilityBudget defaults
// ============================================

describe("CapabilityBudget defaults", () => {
	test("TUI budget matches spec", () => {
		expect(DEFAULT_TUI_BUDGET.maxWallclockMs).toBe(2 * 60 * 60 * 1000);
		expect(DEFAULT_TUI_BUDGET.maxToolCalls).toBe(500);
		expect(DEFAULT_TUI_BUDGET.maxCloudUsd).toBe(0);
		expect(DEFAULT_TUI_BUDGET.maxFilesModified).toBe(50);
		expect(DEFAULT_TUI_BUDGET.maxEgressBytes).toBe(100 * 1024 * 1024);
	});

	test("computer-use budget matches spec and adds hard switches", () => {
		expect(DEFAULT_COMPUTER_USE_BUDGET.maxWallclockMs).toBe(60 * 60 * 1000);
		expect(DEFAULT_COMPUTER_USE_BUDGET.maxToolCalls).toBe(500);
		expect(DEFAULT_COMPUTER_USE_BUDGET.maxCloudUsd).toBe(0);
		expect(DEFAULT_COMPUTER_USE_BUDGET.maxFilesModified).toBe(50);
		expect(DEFAULT_COMPUTER_USE_BUDGET.maxEgressBytes).toBe(100 * 1024 * 1024);
		expect(DEFAULT_COMPUTER_USE_BUDGET.financialDomainsBlocked).toBe(true);
		expect(DEFAULT_COMPUTER_USE_BUDGET.passwordFieldsBlocked).toBe(true);
		expect(DEFAULT_COMPUTER_USE_BUDGET.sudoBlocked).toBe(true);
	});
});

// ============================================
// evaluateBudget — each axis
// ============================================

const ZERO_COUNTERS = (): BudgetCounters => ({
	wallclockMs: 0,
	toolCalls: 0,
	cloudUsd: 0,
	filesModified: 0,
	egressBytes: 0,
});

describe("evaluateBudget", () => {
	test("allows when no axis exceeded", () => {
		const r = evaluateBudget("run-1", ZERO_COUNTERS(), DEFAULT_TUI_BUDGET);
		expect(r.allowed).toBe(true);
	});

	test("blocks on wallclock exceeded", () => {
		const c = ZERO_COUNTERS();
		c.wallclockMs = DEFAULT_TUI_BUDGET.maxWallclockMs + 1;
		const r = evaluateBudget("run-1", c, DEFAULT_TUI_BUDGET);
		expect(r.allowed).toBe(false);
		if (!r.allowed) expect(r.reason).toBe("exceeded:wallclock");
	});

	test("blocks on tool-calls exceeded", () => {
		const c = ZERO_COUNTERS();
		c.toolCalls = DEFAULT_TUI_BUDGET.maxToolCalls + 1;
		const r = evaluateBudget("run-1", c, DEFAULT_TUI_BUDGET);
		expect(r.allowed).toBe(false);
		if (!r.allowed) expect(r.reason).toBe("exceeded:tool-calls");
	});

	test("blocks on cloud-usd exceeded (default cap is $0)", () => {
		const c = ZERO_COUNTERS();
		c.cloudUsd = 0.01;
		const r = evaluateBudget("run-1", c, DEFAULT_TUI_BUDGET);
		expect(r.allowed).toBe(false);
		if (!r.allowed) expect(r.reason).toBe("exceeded:cloud-usd");
	});

	test("blocks on files-modified exceeded", () => {
		const c = ZERO_COUNTERS();
		c.filesModified = DEFAULT_TUI_BUDGET.maxFilesModified + 1;
		const r = evaluateBudget("run-1", c, DEFAULT_TUI_BUDGET);
		expect(r.allowed).toBe(false);
		if (!r.allowed) expect(r.reason).toBe("exceeded:files-modified");
	});

	test("blocks on egress-bytes exceeded", () => {
		const c = ZERO_COUNTERS();
		c.egressBytes = DEFAULT_TUI_BUDGET.maxEgressBytes + 1;
		const r = evaluateBudget("run-1", c, DEFAULT_TUI_BUDGET);
		expect(r.allowed).toBe(false);
		if (!r.allowed) expect(r.reason).toBe("exceeded:egress-bytes");
	});

	test("cloud-with-secrets is blocked regardless of budget headroom", () => {
		const c = ZERO_COUNTERS();
		c.currentAttemptCloudTier = true;
		c.scrubbedSecretMarkers = ["openai-key"];
		const r = evaluateBudget("run-1", c, DEFAULT_TUI_BUDGET);
		expect(r.allowed).toBe(false);
		if (!r.allowed) expect(r.reason).toBe("cloud-with-secrets-blocked");
	});

	test("cloud-tier allowed when no scrubbed secrets present (budget permitting)", () => {
		const looseBudget: CapabilityBudget = {
			...DEFAULT_TUI_BUDGET,
			maxCloudUsd: 100,
		};
		const c = ZERO_COUNTERS();
		c.currentAttemptCloudTier = true;
		c.scrubbedSecretMarkers = [];
		const r = evaluateBudget("run-1", c, looseBudget);
		expect(r.allowed).toBe(true);
	});

	test("local tier allowed even when scrubbed secrets present", () => {
		const c = ZERO_COUNTERS();
		c.currentAttemptCloudTier = false;
		c.scrubbedSecretMarkers = ["openai-key", "github-pat"];
		const r = evaluateBudget("run-1", c, DEFAULT_TUI_BUDGET);
		expect(r.allowed).toBe(true);
	});

	test("cloud-with-secrets check fires BEFORE any budget axis", () => {
		const c = ZERO_COUNTERS();
		c.wallclockMs = DEFAULT_TUI_BUDGET.maxWallclockMs + 1; // would otherwise trigger wallclock
		c.currentAttemptCloudTier = true;
		c.scrubbedSecretMarkers = ["jwt"];
		const r = evaluateBudget("run-1", c, DEFAULT_TUI_BUDGET);
		expect(r.allowed).toBe(false);
		if (!r.allowed) expect(r.reason).toBe("cloud-with-secrets-blocked");
	});
});

// ============================================
// Deny-list — each pattern class
// ============================================

describe("matchDenyList", () => {
	test("blocks rm -rf outside /tmp", () => {
		const r = matchDenyList({ name: "bash", args: "rm -rf /Users/foo/project" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("rm-rf-outside-tmp");
	});

	test("allows rm -rf inside /tmp", () => {
		const r = matchDenyList({ name: "bash", args: "rm -rf /tmp/scratch" });
		expect(r.denied).toBe(false);
	});

	test("allows rm -rf inside /private/tmp", () => {
		const r = matchDenyList({ name: "bash", args: "rm -rf /private/tmp/work" });
		expect(r.denied).toBe(false);
	});

	test("blocks git push --force", () => {
		const r = matchDenyList({ name: "bash", args: "git push --force origin some-branch" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("git-push-force");
	});

	test("blocks git push -f", () => {
		const r = matchDenyList({ name: "bash", args: "git push -f origin feat/x" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("git-push-force");
	});

	test("blocks git push to main", () => {
		const r = matchDenyList({ name: "bash", args: "git push origin main" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("git-push-protected-branch");
	});

	test("blocks git push to master", () => {
		const r = matchDenyList({ name: "bash", args: "git push origin master" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("git-push-protected-branch");
	});

	test("allows git push to feature branch", () => {
		const r = matchDenyList({ name: "bash", args: "git push -u origin feat/go-policy-gates" });
		expect(r.denied).toBe(false);
	});

	test("blocks gh pr merge --admin", () => {
		const r = matchDenyList({ name: "bash", args: "gh pr merge 123 --admin --squash" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("gh-pr-merge-admin");
	});

	test("blocks financial domains (Stripe)", () => {
		const r = matchDenyList({
			name: "fetch",
			args: { url: "https://api.stripe.com/v1/charges" },
		});
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("financial-domain");
	});

	test("blocks financial domains (Polar)", () => {
		const r = matchDenyList({ name: "bash", args: "curl https://api.polar.sh/v1/orders" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("financial-domain");
	});

	test("blocks financial domains (bank)", () => {
		const r = matchDenyList({ name: "bash", args: "curl https://www.chase.com/login" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("financial-domain");
	});

	test("blocks defaults write", () => {
		const r = matchDenyList({
			name: "bash",
			args: "defaults write com.apple.dock autohide -bool true",
		});
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("defaults-write");
	});

	test("blocks sudo", () => {
		const r = matchDenyList({ name: "bash", args: "sudo apt-get install -y curl" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("sudo");
	});

	test("blocks sudo via pipeline", () => {
		const r = matchDenyList({ name: "bash", args: "echo hi | sudo tee /etc/hosts" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("sudo");
	});

	test("blocks DNS mutation via networksetup", () => {
		const r = matchDenyList({
			name: "bash",
			args: "networksetup -setdnsservers Wi-Fi 1.1.1.1",
		});
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("dns-mx-mutation");
	});

	test("blocks DNS mutation via route53", () => {
		const r = matchDenyList({
			name: "bash",
			args: "aws route53 change-resource-record-sets --hosted-zone-id Z123",
		});
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("dns-mx-mutation");
	});

	test("blocks MX record edit via cloudflare cli", () => {
		const r = matchDenyList({
			name: "bash",
			args: "cloudflare dns record update example.com MX 10 mail",
		});
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("dns-mx-mutation");
	});

	test("blocks credential export via env-var export", () => {
		const r = matchDenyList({ name: "bash", args: "export GITHUB_TOKEN=abc123" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("credential-export");
	});

	test("blocks cat ~/.ssh/id_rsa", () => {
		const r = matchDenyList({ name: "bash", args: "cat ~/.ssh/id_rsa" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("credential-export");
	});

	test("blocks aws iam create-access-key", () => {
		const r = matchDenyList({ name: "bash", args: "aws iam create-access-key --user-name foo" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("credential-export");
	});

	test("blocks npm publish", () => {
		const r = matchDenyList({ name: "bash", args: "npm publish --access public" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("npm-publish");
	});

	test("blocks bun publish too", () => {
		const r = matchDenyList({ name: "bash", args: "bun publish" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("npm-publish");
	});

	test("blocks fly deploy --prod", () => {
		const r = matchDenyList({ name: "bash", args: "fly deploy --prod" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("fly-deploy-prod");
	});

	test("blocks fly deploy --app eight-vessel-prod", () => {
		const r = matchDenyList({ name: "bash", args: "flyctl deploy --app eight-vessel-prod" });
		expect(r.denied).toBe(true);
		expect(r.pattern).toBe("fly-deploy-prod");
	});

	test("allows fly deploy to dev app", () => {
		const r = matchDenyList({ name: "bash", args: "fly deploy --app eight-vessel-dev" });
		expect(r.denied).toBe(false);
	});

	test("allows benign bash command", () => {
		const r = matchDenyList({ name: "bash", args: "ls -la packages/permissions" });
		expect(r.denied).toBe(false);
	});

	test("deny-list constant exposes all expected pattern ids", () => {
		const ids = GO_DENY_LIST.map((p) => p.id).sort();
		expect(ids).toEqual(
			[
				"credential-export",
				"defaults-write",
				"dns-mx-mutation",
				"financial-domain",
				"fly-deploy-prod",
				"gh-pr-merge-admin",
				"git-push-force",
				"git-push-protected-branch",
				"npm-publish",
				"rm-rf-outside-tmp",
				"sudo",
			].sort(),
		);
	});
});

// ============================================
// Secret scrub — each regex
// ============================================

describe("scrubGoalText", () => {
	test("detects sk-* OpenAI-style key", () => {
		const r = scrubGoalText("here is sk-AAAAAAAAAAAAAAAAAAAAAAAA in the prompt");
		expect(r.foundSecrets).toContain("openai-key");
		expect(r.clean).toContain("[REDACTED:openai-key]");
		expect(r.clean).not.toContain("sk-AAAAAAAAAAAAAAAAAAAAAAAA");
	});

	test("detects ghp_* GitHub PAT", () => {
		const r = scrubGoalText("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ goes here");
		expect(r.foundSecrets).toContain("github-pat");
		expect(r.clean).toContain("[REDACTED:github-pat]");
	});

	test("detects AKIA AWS access key", () => {
		const r = scrubGoalText("AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP rest");
		expect(r.foundSecrets).toContain("aws-access-key");
		expect(r.clean).toContain("[REDACTED:aws-access-key]");
	});

	test("detects JWT three-segment token", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiJ9_padding.eyJzdWIiOiIxMjM0NTYifQ_padding.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
		const r = scrubGoalText(`Authorization: Bearer ${jwt}`);
		expect(r.foundSecrets).toContain("jwt");
		expect(r.clean).toContain("[REDACTED:jwt]");
	});

	test("detects inline password= assignment", () => {
		const r = scrubGoalText("connect with password=hunter2");
		expect(r.foundSecrets).toContain("password-kv");
	});

	test("detects inline api_key= assignment", () => {
		const r = scrubGoalText("send with api_key=abcd1234efgh");
		expect(r.foundSecrets).toContain("api-key-kv");
	});

	test("detects api-key= assignment (hyphen variant)", () => {
		const r = scrubGoalText("api-key=somevalue99");
		expect(r.foundSecrets).toContain("api-key-kv");
	});

	test("returns empty foundSecrets on clean text", () => {
		const r = scrubGoalText("Implement the /goal capability budget for issue #2609.");
		expect(r.foundSecrets).toEqual([]);
		expect(r.clean).toBe("Implement the /goal capability budget for issue #2609.");
	});

	test("containsSecret convenience returns true on hit", () => {
		expect(containsSecret("API_KEY=AKIAABCDEFGHIJKLMNOP")).toBe(true);
	});

	test("containsSecret convenience returns false on clean text", () => {
		expect(containsSecret("nothing dangerous here")).toBe(false);
	});

	test("regex pack exposes all expected pattern ids", () => {
		const ids = SECRET_PATTERNS.map((p) => p.id).sort();
		expect(ids).toEqual(
			[
				"openai-key",
				"github-pat",
				"aws-access-key",
				"jwt",
				"password-kv",
				"api-key-kv",
			].sort(),
		);
	});

	test("handles empty/null input gracefully", () => {
		const r = scrubGoalText("");
		expect(r.clean).toBe("");
		expect(r.foundSecrets).toEqual([]);
	});
});

// ============================================
// HMAC sign/verify
// ============================================

describe("goal-state-hmac", () => {
	let tmpDir: string;
	let originalDataDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "go-hmac-"));
		originalDataDir = process.env.EIGHT_DATA_DIR;
		process.env.EIGHT_DATA_DIR = tmpDir;
	});

	afterEach(() => {
		if (originalDataDir === undefined) delete process.env.EIGHT_DATA_DIR;
		else process.env.EIGHT_DATA_DIR = originalDataDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("sign and verify roundtrip succeeds", () => {
		const payload = { runId: "r-1", step: 7, files: ["a", "b"] };
		const signed = signState(payload);
		expect(signed.sig).toMatch(/^[0-9a-f]{64}$/);
		expect(verifyState(signed)).toBe(true);
	});

	test("verify rejects tampered payload", () => {
		const signed = signState({ runId: "r-1", step: 7 });
		const tampered = { ...signed, payload: { runId: "r-1", step: 8 } };
		expect(verifyState(tampered)).toBe(false);
	});

	test("verify rejects tampered signature", () => {
		const signed = signState({ runId: "r-1" });
		// Flip the last hex char
		const lastChar = signed.sig.slice(-1);
		const flipped = lastChar === "0" ? "1" : "0";
		const tampered = { ...signed, sig: signed.sig.slice(0, -1) + flipped };
		expect(verifyState(tampered)).toBe(false);
	});

	test("verify rejects payload signed with different key", () => {
		const payload = { runId: "r-1" };
		const keyA = crypto.randomBytes(32);
		const keyB = crypto.randomBytes(32);
		const signed = signState(payload, keyA);
		expect(verifyState(signed, keyB)).toBe(false);
		expect(verifyState(signed, keyA)).toBe(true);
	});

	test("verifyOrThrow throws on bad sig", () => {
		const signed = signState({ x: 1 });
		const tampered = { ...signed, sig: "0".repeat(64) };
		expect(() => verifyOrThrow(tampered)).toThrow(/signature mismatch/i);
	});

	test("verifyOrThrow does not throw on good sig", () => {
		const signed = signState({ x: 1 });
		expect(() => verifyOrThrow(signed)).not.toThrow();
	});

	test("key file is created with 0600 perms on first sign", () => {
		signState({ first: true });
		const keyPath = path.join(tmpDir, "keys", "state-hmac.key");
		expect(fs.existsSync(keyPath)).toBe(true);
		const mode = fs.statSync(keyPath).mode & 0o777;
		// On POSIX expect 0600. On Windows mode bits are not reliable; allow either.
		if (process.platform !== "win32") {
			expect(mode).toBe(0o600);
		}
	});

	test("key file is reused across calls (deterministic sig)", () => {
		const payload = { x: 1, y: 2 };
		const s1 = signState(payload);
		const s2 = signState(payload);
		expect(s1.sig).toBe(s2.sig);
	});

	test("signing is order-insensitive for object keys", () => {
		const a = signState({ x: 1, y: 2 });
		const b = signState({ y: 2, x: 1 });
		expect(a.sig).toBe(b.sig);
	});

	test("loadOrCreateKey rejects wrong-sized existing key", () => {
		const keyPath = path.join(tmpDir, "keys", "state-hmac.key");
		fs.mkdirSync(path.dirname(keyPath), { recursive: true });
		fs.writeFileSync(keyPath, Buffer.from("short"), { mode: 0o600 });
		expect(() => loadOrCreateKey()).toThrow(/wrong length/i);
	});

	test("verify returns false on malformed signed payload", () => {
		// @ts-expect-error: intentionally malformed
		expect(verifyState(null)).toBe(false);
		// @ts-expect-error: intentionally malformed
		expect(verifyState({ payload: {} })).toBe(false);
		// @ts-expect-error: intentionally malformed
		expect(verifyState({ sig: "abc" })).toBe(false);
	});
});
