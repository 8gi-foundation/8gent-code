/**
 * SecretScanner tests.
 *
 * Pattern docs sourced clean-room from public secret-format references
 * (provider documentation, GitHub secret-scanning docs). Each rule has
 * 3+ positive cases and 3+ negative (false-positive guard) cases.
 *
 * Issue: 8gi-foundation/8gent-code#2464.
 */

import { describe, expect, it } from "bun:test";
import {
	MAX_ATTACHMENT_BASE64_CHARS,
	MAX_SCAN_CHARS,
	scrub,
	scrubKeepingAttachment,
} from "../secret-scanner";

describe("SecretScanner - AWS access key id", () => {
	it("redacts an AKIA key", () => {
		const out = scrub("key: AKIAIOSFODNN7EXAMPLE here");
		expect(out.scrubbed).toContain("[REDACTED:aws_access_key]");
		expect(out.scrubbed).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(out.redactedCount).toBe(1);
		expect(out.rules).toContain("aws_access_key");
	});

	it("redacts an ASIA temporary key", () => {
		const out = scrub("ASIAY34FZKBOKMUTVV7A");
		expect(out.scrubbed).toContain("[REDACTED:aws_access_key]");
		expect(out.redactedCount).toBe(1);
	});

	it("redacts an A3T prefixed key inside JSON", () => {
		const out = scrub('{"key":"A3TGABCDEFGHIJKLMNOP"}');
		expect(out.scrubbed).toContain("[REDACTED:aws_access_key]");
	});

	it("does NOT redact a 19-char string (too short)", () => {
		const out = scrub("AKIASHORTKEY1234567");
		expect(out.scrubbed).toBe("AKIASHORTKEY1234567");
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact lowercase akia prefix", () => {
		const out = scrub("akiaiosfodnn7example");
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact AKIA inside a longer alphanumeric word", () => {
		const out = scrub("xAKIAIOSFODNN7EXAMPLEx");
		expect(out.redactedCount).toBe(0);
	});
});

describe("SecretScanner - GCP API key", () => {
	it("redacts a basic AIza key", () => {
		// AIza + 35 chars [\w-]: tail length = 35.
		const out = scrub("key=AIzaSyA-1234567890abcdefghijklmnopqrstu");
		expect(out.scrubbed).toContain("[REDACTED:gcp_api_key]");
		expect(out.redactedCount).toBe(1);
	});

	it("redacts AIza key with hyphens and underscores", () => {
		const out = scrub("AIzaSy_-abcdefghijklmnopqrstuvwxyz01234");
		expect(out.scrubbed).toContain("[REDACTED:gcp_api_key]");
	});

	it("redacts AIza key inside a URL query param", () => {
		const out = scrub("https://maps.googleapis.com/?k=AIzaSyB1234567890abcdefghijklmnopqrstuv");
		expect(out.scrubbed).toContain("[REDACTED:gcp_api_key]");
	});

	it("does NOT redact AIza prefix that is too short", () => {
		const out = scrub("AIzaShort");
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact AIza with a space mid-key", () => {
		const out = scrub("AIzaSyA 1234567890abcdefghijklmnopqrstu");
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact lowercase aiza prefix", () => {
		const out = scrub("aizaSyA1234567890abcdefghijklmnopqrstu");
		expect(out.redactedCount).toBe(0);
	});
});

describe("SecretScanner - Anthropic API key", () => {
	const validKey = `sk-ant-api03-${"a".repeat(93)}AA`;

	it("redacts a real-shaped Anthropic key", () => {
		const out = scrub(validKey);
		expect(out.scrubbed).toBe("[REDACTED:anthropic_api_key]");
		expect(out.redactedCount).toBe(1);
	});

	it("redacts a key with mixed case + underscores + hyphens", () => {
		const body = `${"A".repeat(30)}_${"b".repeat(30)}-${"C".repeat(31)}`;
		const out = scrub(`token=sk-ant-api03-${body}AA next`);
		expect(out.scrubbed).toContain("[REDACTED:anthropic_api_key]");
	});

	it("redacts a key embedded in a JSON value", () => {
		const out = scrub(`{"x":"sk-ant-api03-${"z".repeat(93)}AA"}`);
		expect(out.scrubbed).toContain("[REDACTED:anthropic_api_key]");
	});

	it("does NOT fire anthropic_api_key on a key missing the AA suffix", () => {
		const out = scrub(`sk-ant-api03-${"a".repeat(93)}XX`);
		// Still sk- shaped, so the generic rule takes it (#3203).
		expect(out.rules).not.toContain("anthropic_api_key");
		expect(out.rules).toContain("sk_api_key");
	});

	it("does NOT fire anthropic_api_key on sk-ant-api01 (wrong version)", () => {
		const out = scrub(`sk-ant-api01-${"a".repeat(93)}AA`);
		// Still sk- shaped, so the generic rule takes it (#3203).
		expect(out.rules).not.toContain("anthropic_api_key");
		expect(out.rules).toContain("sk_api_key");
	});

	it("does NOT fire anthropic_api_key on a too-short body", () => {
		const out = scrub(`sk-ant-api03-${"a".repeat(20)}AA`);
		// Still sk- shaped, so the generic rule takes it (#3203).
		expect(out.rules).not.toContain("anthropic_api_key");
		expect(out.rules).toContain("sk_api_key");
	});
});

describe("SecretScanner - OpenAI API key", () => {
	const a = "A".repeat(20);
	const b = "B".repeat(20);
	const validKey = `sk-${a}T3BlbkFJ${b}`;

	it("redacts a basic OpenAI key", () => {
		const out = scrub(`OPENAI_API_KEY=${validKey}`);
		expect(out.scrubbed).toContain("[REDACTED:openai_api_key]");
		expect(out.redactedCount).toBe(1);
	});

	it("redacts an OpenAI key embedded in a sentence", () => {
		const out = scrub(`use ${validKey} please`);
		expect(out.scrubbed).toContain("[REDACTED:openai_api_key]");
	});

	it("redacts an OpenAI key with longer suffixes", () => {
		const longKey = `sk-${"x".repeat(40)}T3BlbkFJ${"y".repeat(40)}`;
		const out = scrub(longKey);
		expect(out.scrubbed).toBe("[REDACTED:openai_api_key]");
	});

	it("does NOT redact sk- prefix without T3BlbkFJ marker", () => {
		const out = scrub(`sk-${"a".repeat(48)}`);
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact T3BlbkFJ marker without sk- prefix", () => {
		const out = scrub(`abc-T3BlbkFJ${"y".repeat(20)}`);
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT fire openai_api_key on a too-short suffix after T3BlbkFJ", () => {
		const out = scrub(`sk-${a}T3BlbkFJ${"y".repeat(5)}`);
		// Still sk- shaped, so the generic rule takes it (#3203).
		expect(out.rules).not.toContain("openai_api_key");
		expect(out.rules).toContain("sk_api_key");
	});
});

describe("SecretScanner - DigitalOcean PAT", () => {
	const valid = `dop_v1_${"a".repeat(64)}`;

	it("redacts a DO PAT", () => {
		const out = scrub(`token: ${valid}`);
		expect(out.scrubbed).toContain("[REDACTED:digitalocean_pat]");
		expect(out.redactedCount).toBe(1);
	});

	it("redacts hex DO PAT with f and 0 chars", () => {
		const out = scrub(`dop_v1_${"f".repeat(32)}${"0".repeat(32)}`);
		expect(out.scrubbed).toContain("[REDACTED:digitalocean_pat]");
	});

	it("redacts DO PAT inside curl command", () => {
		const out = scrub(`curl -H "Authorization: Bearer ${valid}"`);
		expect(out.scrubbed).toContain("[REDACTED:digitalocean_pat]");
	});

	it("does NOT redact dop_v1_ with non-hex chars", () => {
		const out = scrub(`dop_v1_${"Z".repeat(64)}`);
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact dop_v2_ (wrong version)", () => {
		const out = scrub(`dop_v2_${"a".repeat(64)}`);
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact a too-short hex tail", () => {
		const out = scrub(`dop_v1_${"a".repeat(32)}`);
		expect(out.redactedCount).toBe(0);
	});
});

describe("SecretScanner - GitHub tokens", () => {
	it("redacts a ghp_ token", () => {
		const out = scrub(`ghp_${"A".repeat(36)}`);
		expect(out.scrubbed).toContain("[REDACTED:github_token]");
	});

	it("redacts a github_pat_ fine-grained token", () => {
		const out = scrub(`github_pat_${"a".repeat(82)}`);
		expect(out.scrubbed).toContain("[REDACTED:github_token]");
	});

	it("redacts ghp_ token mixed case", () => {
		const out = scrub(`token=ghp_aB3${"x".repeat(33)}`);
		expect(out.scrubbed).toContain("[REDACTED:github_token]");
	});

	it("does NOT redact ghp_ with too-short tail", () => {
		const out = scrub(`ghp_${"a".repeat(20)}`);
		expect(out.redactedCount).toBe(0);
	});

	it("redacts gho_ / ghs_ tokens", () => {
		expect(scrub(`gho_${"a".repeat(36)}`).scrubbed).toBe("[REDACTED:github_token]");
		expect(scrub(`ghs_${"b".repeat(36)}`).scrubbed).toBe("[REDACTED:github_token]");
	});

	it("does NOT redact ghp_ with hyphen (invalid char)", () => {
		const out = scrub(`ghp_${"a".repeat(17)}-${"b".repeat(18)}`);
		expect(out.redactedCount).toBe(0);
	});
});

describe("SecretScanner - Slack bot/user tokens", () => {
	it("redacts an xoxb- bot token", () => {
		const out = scrub(`xoxb-1234567890-abcdef-ghijklmnop`);
		expect(out.scrubbed).toContain("[REDACTED:slack_token]");
	});

	it("redacts an xoxp- user token", () => {
		const out = scrub(`xoxp-${"1".repeat(40)}`);
		expect(out.scrubbed).toContain("[REDACTED:slack_token]");
	});

	it("redacts a long Slack token", () => {
		const out = scrub(`xoxb-${"a".repeat(70)}`);
		expect(out.scrubbed).toContain("[REDACTED:slack_token]");
	});

	it("redacts xoxa- and xoxr- tokens", () => {
		expect(scrub(`xoxa-${"1".repeat(30)}`).scrubbed).toContain("[REDACTED:slack_token]");
		expect(scrub(`xoxr-${"2".repeat(30)}`).scrubbed).toContain("[REDACTED:slack_token]");
	});

	it("does NOT redact xoxb- with too-short tail", () => {
		const out = scrub(`xoxb-1234`);
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact xoxb- with invalid chars (spaces)", () => {
		const out = scrub(`xoxb-12345 abcdef ghij`);
		expect(out.redactedCount).toBe(0);
	});
});

describe("SecretScanner - secret-named assignment", () => {
	it("redacts a high-entropy string after api_key=", () => {
		const out = scrub(`api_key=R7g!q3xZw9PvL2hN8jM4kB6yT5sH1cV0eA8oXkJzWqUbDfGrSnEcLtY`);
		expect(out.scrubbed).toContain("[REDACTED:secret_assignment]");
		expect(out.redactedCount).toBeGreaterThanOrEqual(1);
	});

	it("redacts a high-entropy string after secret:", () => {
		const out = scrub(`secret: aZ1bY2cX3dW4eV5fU6gT7hS8iR9jQ0kP_lO-mN+oM=pL`);
		expect(out.scrubbed).toContain("[REDACTED:secret_assignment]");
	});

	it("redacts a high-entropy string after password=", () => {
		const out = scrub(`password=Xy7Pq2!nV9$mZ8&kL4@jH3#gF6%dC1*rT0wEsBnQ`);
		expect(out.scrubbed).toContain("[REDACTED:secret_assignment]");
	});

	it("redacts any non-placeholder value after api_key=, entropy or not", () => {
		const out = scrub(`api_key=hello_world_test_value_with_low_entropy_repeating`);
		expect(out.scrubbed).toBe("api_key=[REDACTED:secret_assignment]");
	});

	it("does NOT redact a short plain word after a key name", () => {
		const out = scrub(`api_key=short`);
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact high-entropy string with no adjacent keyword", () => {
		const out = scrub(`R7g!q3xZw9PvL2hN8jM4kB6yT5sH1cV0eA8oXkJzWqUbDfGrSnEcLtY`);
		expect(out.redactedCount).toBe(0);
	});
});

describe("SecretScanner - mixed and edge", () => {
	it("scrubs multiple distinct rules in one pass", () => {
		const aws = "AKIAIOSFODNN7EXAMPLE";
		const gcp = "AIzaSyA-1234567890abcdefghijklmnopqrstu";
		const gh = `ghp_${"X".repeat(36)}`;
		const out = scrub(`AWS=${aws} GCP=${gcp} GH=${gh}`);
		expect(out.redactedCount).toBe(3);
		expect(out.rules).toContain("aws_access_key");
		expect(out.rules).toContain("gcp_api_key");
		expect(out.rules).toContain("github_token");
		expect(out.scrubbed).not.toContain(aws);
		expect(out.scrubbed).not.toContain(gcp);
		expect(out.scrubbed).not.toContain(gh);
	});

	it("returns byte-identical output when no matches", () => {
		const text = "function add(a, b) { return a + b; }\n// no secrets here";
		const out = scrub(text);
		expect(out.scrubbed).toBe(text);
		expect(out.redactedCount).toBe(0);
		expect(out.rules).toEqual([]);
	});

	it("handles empty input", () => {
		const out = scrub("");
		expect(out.scrubbed).toBe("");
		expect(out.redactedCount).toBe(0);
	});

	it("rules array contains only unique rule ids", () => {
		const out = scrub(`AKIAIOSFODNN7EXAMPLE and ASIAY34FZKBOKMUTVV7A`);
		expect(out.redactedCount).toBe(2);
		expect(out.rules).toEqual(["aws_access_key"]);
	});
});

describe("SecretScanner - performance", () => {
	it("scrubs 1MB of input in under 50ms", () => {
		// Build ~1MB of mixed content with secrets sprinkled throughout.
		const filler = "lorem ipsum dolor sit amet ".repeat(40);
		const aws = "AKIAIOSFODNN7EXAMPLE";
		const gh = `ghp_${"X".repeat(36)}`;
		const chunk = `${filler} ${aws} more text ${gh} end\n`;
		const blocks: string[] = [];
		let bytes = 0;
		while (bytes < 1_048_576) {
			blocks.push(chunk);
			bytes += chunk.length;
		}
		const input = blocks.join("");
		expect(input.length).toBeGreaterThanOrEqual(1_048_576);

		const start = performance.now();
		const out = scrub(input);
		const elapsed = performance.now() - start;

		expect(out.redactedCount).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(50);
	});
});

// #3203: the nine .env lines from the 8TO/8SO evidence comment
// (issuecomment 6113428060). Values are random-shaped, generated from a
// seeded PRNG so the test is deterministic.
function rand(len: number, alphabet: string, seed: number): string {
	let x = seed >>> 0 || 1;
	let s = "";
	for (let i = 0; i < len; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		s += alphabet[(x >>> 0) % alphabet.length];
	}
	return s;
}
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const URLSAFE = `${ALNUM}_-`;
const B64 = `${ALNUM}/+`;
const HEX = "0123456789abcdef";

describe("SecretScanner - #3203 .env table (all nine must redact)", () => {
	const secrets = {
		openai: `sk-proj-${rand(48, URLSAFE, 1)}`,
		anthropic: `sk-ant-api03-${rand(93, URLSAFE, 2)}AA`,
		stripe: `sk_live_${rand(24, ALNUM, 3)}`,
		awsSecret: rand(40, B64, 4),
		dbPass: rand(16, ALNUM, 5),
		telegram: `123456789:AA${rand(33, URLSAFE, 6)}`,
		openrouter: `sk-or-v1-${rand(64, HEX, 7)}`,
		apiKey: rand(32, ALNUM, 8),
		password: rand(20, ALNUM, 9),
	};
	const lines: [string, string][] = [
		[`OPENAI_API_KEY=${secrets.openai}`, secrets.openai],
		[`ANTHROPIC_API_KEY=${secrets.anthropic}`, secrets.anthropic],
		[`STRIPE_SECRET_KEY=${secrets.stripe}`, secrets.stripe],
		[`AWS_SECRET_ACCESS_KEY=${secrets.awsSecret}`, secrets.awsSecret],
		[`DATABASE_URL=postgres://admin:${secrets.dbPass}@host/x`, secrets.dbPass],
		[`TELEGRAM_BOT_TOKEN=${secrets.telegram}`, secrets.telegram],
		[`OPENROUTER_API_KEY=${secrets.openrouter}`, secrets.openrouter],
		[`API_KEY=${secrets.apiKey}`, secrets.apiKey],
		[`password: ${secrets.password}`, secrets.password],
	];

	for (const [line, secret] of lines) {
		it(`redacts: ${line.slice(0, 28)}...`, () => {
			const out = scrub(line);
			expect(out.redactedCount).toBeGreaterThanOrEqual(1);
			expect(out.scrubbed).not.toContain(secret);
			expect(out.scrubbed).toContain("[REDACTED:");
		});
	}

	it("redacts all nine as one cat .env output and keeps every name", () => {
		const env = lines.map(([l]) => l).join("\n");
		const out = scrub(env);
		for (const s of Object.values(secrets)) expect(out.scrubbed).not.toContain(s);
		for (const name of [
			"OPENAI_API_KEY",
			"STRIPE_SECRET_KEY",
			"AWS_SECRET_ACCESS_KEY",
			"DATABASE_URL",
			"TELEGRAM_BOT_TOKEN",
			"password",
		]) {
			expect(out.scrubbed).toContain(name);
		}
		expect(out.scrubbed).toContain("postgres://admin:[REDACTED:url_password]@host/x");
		expect(out.scrubbed.split("\n").length).toBe(9);
	});
});

describe("SecretScanner - #3203 value shapes without a name", () => {
	const cases: [string, string, string][] = [
		["sk-proj", `use sk-proj-${rand(48, URLSAFE, 11)} now`, "openai_api_key"],
		["sk-or-v1", `sk-or-v1-${rand(64, HEX, 12)}`, "openrouter_api_key"],
		["generic sk-", `sk-${rand(40, ALNUM, 13)}9`, "sk_api_key"],
		["sk_test", `sk_test_${rand(24, ALNUM, 14)}`, "stripe_key"],
		["rk_live", `rk_live_${rand(24, ALNUM, 15)}`, "stripe_key"],
		["telegram", `bot ${"987654321"}:AA${rand(33, URLSAFE, 16)} ok`, "telegram_bot_token"],
		[
			"jwt",
			`Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${rand(43, URLSAFE, 17)}`,
			"jwt",
		],
		[
			"url password",
			`git clone https://bob:${rand(20, ALNUM, 18)}@example.com/r.git`,
			"url_password",
		],
		["aws pair", `AKIAIOSFODNN7EXAMPLE ${rand(40, B64, 19)}`, "aws_secret_key"],
		["aws named lowercase", `aws_secret_access_key = ${rand(40, B64, 20)}`, "aws_secret_key"],
	];
	for (const [label, input, rule] of cases) {
		it(`redacts ${label}`, () => {
			const out = scrub(input);
			expect(out.rules).toContain(rule);
		});
	}

	it("redacts a full PEM private key block", () => {
		const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${rand(64, B64, 21)}\n${rand(64, B64, 22)}\n-----END OPENSSH PRIVATE KEY-----`;
		const out = scrub(`before\n${pem}\nafter`);
		expect(out.scrubbed).toBe("before\n[REDACTED:private_key_block]\nafter");
	});

	it("redacts a truncated PEM block to the end", () => {
		const out = scrub(`-----BEGIN RSA PRIVATE KEY-----\n${rand(64, B64, 23)}`);
		expect(out.scrubbed).toBe("[REDACTED:private_key_block]");
	});

	it("keeps the name and quotes in JSON and YAML", () => {
		expect(scrub(`{"client_secret": "${rand(30, ALNUM, 24)}"}`).scrubbed).toBe(
			`{"client_secret": "[REDACTED:secret_assignment]"}`,
		);
		expect(scrub(`  dbPassword: hunter2`).scrubbed).toBe(
			"  dbPassword: [REDACTED:secret_assignment]",
		);
		expect(scrub(`export GH_TOKEN='abc123def456'`).scrubbed).toBe(
			"export GH_TOKEN='[REDACTED:secret_assignment]'",
		);
		expect(scrub(`mysql --password=s3cr3t -u root`).scrubbed).toBe(
			"mysql --password=[REDACTED:secret_assignment] -u root",
		);
	});

	it("matches every secret-word name variant", () => {
		for (const name of [
			"MY_PASSWD",
			"DB_PWD",
			"GOOGLE_CREDENTIALS",
			"BASIC_AUTH",
			"SSH_PRIVATE",
			"x-api-key",
			"apiKey",
			"accessToken",
		]) {
			const out = scrub(`${name}=Zq8${rand(12, ALNUM, 25)}`);
			expect(out.rules).toEqual(["secret_assignment"]);
		}
	});
});

describe("SecretScanner - #3203 false-positive guard (must stay untouched)", () => {
	const negatives = [
		"commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
		"HEAD is now at ecebfdda fix(permissions): pass rm -f",
		"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 refs/heads/main",
		"request id 550e8400-e29b-41d4-a716-446655440000 completed",
		"session=6ba7b810-9dad-11d1-80b4-00c04fd430c8 ok",
		"The token is sent in the header on every request.",
		"Rotate your API key and secret every 90 days.",
		"Enter your password to continue",
		"tokens used: 1523 prompt, 412 completion",
		"max_tokens=4096 temperature=0.2",
		"input_tokens=532 output_tokens=88",
		"sort_key=asc primary_key=id",
		"const token: string = await getToken();",
		"apiKey: process.env.OPENAI_API_KEY,",
		"password: ${DB_PASSWORD}",
		"API_KEY=",
		"SECRET_KEY=<YOUR_SECRET_KEY>",
		"PASSWORD=${DB_PASSWORD}",
		"OPENAI_API_KEY=your-key",
		"token: undefined",
		"auth: true",
		"PRIVATE_KEY_PATH=~/.ssh/id_ed25519",
		"PWD=/Users/james/code",
		"AUTHOR=James Spalding",
		"MONKEY=banana42xyz",
		"https://github.com/8gi-foundation/8gent-code/pull/3944",
		"git@github.com:8gi-foundation/8gent-code.git",
		"postgres://localhost:5432/app",
		"https://user@example.com/path",
		"if (token == null) return;",
		"keys.map((key) => key.id)",
		'className="sk-loading-spinner-container-wrapper"',
		"sk-learn is not a package name",
		"12:30:45 INFO server started on :8080",
		"Authorization header missing",
		"-----BEGIN PUBLIC KEY-----",
		"dGhpcyBpcyBqdXN0IGJhc2U2NCBkYXRhIG5vdCBh",
		"key: value",
		"the auth: flow is described below",
	];
	expect(negatives.length).toBeGreaterThanOrEqual(30);
	for (const line of negatives) {
		it(`leaves alone: ${line.slice(0, 40)}`, () => {
			const out = scrub(line);
			expect(out.scrubbed).toBe(line);
			expect(out.redactedCount).toBe(0);
		});
	}
});

// 8SO review of #4018 (#3203): leaks, false positives and ReDoS found by
// Karen's probes. Every vector below failed against the first fix.
const V20 = "Zq9xLm2pRt7vWk4nBc8d";
const V32 = rand(32, ALNUM, 31);
const V44 = rand(44, ALNUM, 32);
const V64 = rand(64, ALNUM, 33);

function expectHidden(input: string, secret: string) {
	const out = scrub(input);
	expect(out.scrubbed).not.toContain(secret);
	expect(out.scrubbed).toContain("[REDACTED:");
	return out.scrubbed;
}

describe("SecretScanner - 8SO: auth headers and cookies", () => {
	const cases: [string, string][] = [
		[`curl -H "Authorization: Bearer ${V32}" https://x`, V32],
		[`> Authorization: Bearer ${V32}`, V32],
		[`> Authorization: Basic ${V32}`, V32],
		[`Authorization: Token ${V32}`, V32],
		[`Authorization: Digest username="bob", realm="x", response="${V32}"`, V32],
		[`Authorization: ${V32}`, V32],
		[`Proxy-Authorization: Basic ${V32}`, V32],
		[`> Cookie: sid=${V32}; theme=${V20}`, V20],
		[`> Cookie: sid=${V32}`, V32],
		[`< Set-Cookie: session=${V32}; Path=/`, V32],
		[`token was Bearer ${V32} ok`, V32],
		[`> X-Api-Key: ${V32}`, V32],
	];
	for (const [input, secret] of cases)
		it(`hides: ${input.slice(0, 40)}`, () => {
			expectHidden(input, secret);
		});

	it("keeps the scheme word and Set-Cookie attributes", () => {
		expect(scrub(`Authorization: Bearer ${V32}`).scrubbed).toBe(
			"Authorization: Bearer [REDACTED:auth_header]",
		);
		expect(scrub(`Set-Cookie: session=${V32}; Path=/; HttpOnly`).scrubbed).toBe(
			"Set-Cookie: session=[REDACTED:cookie]; Path=/; HttpOnly",
		);
	});
});

describe("SecretScanner - 8SO: CLI flags", () => {
	const cases: [string, string][] = [
		[`mysql --password ${V20} -u root`, V20],
		[`mysql --password="${V20}" -u root`, V20],
		[`gh --token ${V20}`, V20],
		[`mysql -u root -p${V20} db`, V20],
		[`sshpass -p '${V20}' ssh x`, V20],
		[`sshpass -p ${V20} ssh x`, V20],
		[`curl -u admin:${V20} https://x`, V20],
		[`curl -u 'admin:${V20}' https://x`, V20],
		[`curl --user "admin:${V20}" https://x`, V20],
	];
	for (const [input, secret] of cases)
		it(`hides: ${input.slice(0, 40)}`, () => {
			expectHidden(input, secret);
		});

	it("keeps the rest of the command", () => {
		expect(scrub(`curl -u admin:${V20} https://x`).scrubbed).toBe(
			"curl -u admin:[REDACTED:cli_password] https://x",
		);
		expect(scrub(`mysql --password ${V20} -u root`).scrubbed).toBe(
			"mysql --password [REDACTED:secret_assignment] -u root",
		);
	});
});

describe("SecretScanner - 8SO: punctuation tails", () => {
	const cases: [string, string][] = [
		[`SECRET_KEY=${V20}==`, V20],
		[`SECRET_KEY=ab${V20}=cd`, V20],
		[`API_TOKEN=abc=def${V20}`, V20],
		[`password: ab;cd${V20}`, V20],
		[`password: ab,cd${V20}`, `cd${V20}`],
		[`password: ab(cd${V20}`, `cd${V20}`],
		[`secret: ab[cd${V20}`, `cd${V20}`],
		[`PASSWORD=ab"cd${V20}`, V20],
		[`password = "${V20} ${V20}"`, V20],
	];
	for (const [input, secret] of cases)
		it(`hides: ${input.slice(0, 40)}`, () => {
			expectHidden(input, secret);
		});

	it("cuts at , only in JSON or YAML flow context", () => {
		expect(scrub(`{password: ${V20}, user: bob}`).scrubbed).toBe(
			"{password: [REDACTED:secret_assignment], user: bob}",
		);
		expect(scrub(`{"password": "${V20}", "user": "bob"}`).scrubbed).toBe(
			'{"password": "[REDACTED:secret_assignment]", "user": "bob"}',
		);
	});
});

describe("SecretScanner - 8SO: URL userinfo", () => {
	const cases: [string, string][] = [
		[`redis://:${V20}@host:6379`, V20],
		[`postgres://u:p@ss${V20}@host/db`, V20],
		[`postgres://u:ab/cd${V20}@host/db`, `cd${V20}`],
		[`https://${V20}@github.com/a/b`, V20],
		[`mongodb://u:${V20}@h1,h2/db?authSource=admin`, V20],
	];
	for (const [input, secret] of cases)
		it(`hides: ${input.slice(0, 40)}`, () => {
			expectHidden(input, secret);
		});

	it("keeps host and path", () => {
		expect(scrub(`postgres://u:p@ss${V20}@host/db`).scrubbed).toBe(
			"postgres://u:[REDACTED:url_password]@host/db",
		);
		expect(scrub(`https://${V20}@github.com/a/b`).scrubbed).toBe(
			"https://[REDACTED:url_password]@github.com/a/b",
		);
	});
});

describe("SecretScanner - 8SO: short values and name families", () => {
	const cases: [string, string][] = [
		["PASSWORD=hunter2", "hunter2"],
		["PASSWORD=correcthorse", "correcthorse"],
		["SECRET_KEY=abcdefghijklmno", "abcdefghijklmno"],
		["secret: my-secret-value", "my-secret-value"],
		["API_KEY=1234567890123456", "1234567890123456"],
		["API_KEY=abc123", "abc123"],
		[`PASSWORD=/${V20}`, V20],
		[`SECRET=${V20}.${V20}`, V20],
		[`PRIVATE_KEY=config.${V20}`, V20],
		[`"private_key_id": "${rand(40, HEX, 34)}"`, rand(40, HEX, 34)],
	];
	for (const [input, secret] of cases)
		it(`hides: ${input.slice(0, 40)}`, () => {
			expectHidden(input, secret);
		});
});

describe("SecretScanner - 8SO: wrappers and multi-line values", () => {
	const cases: [string, string][] = [
		[`PASSWORD=$ecret${V20}`, V20],
		[`PASSWORD=\${${V20}}`, V20],
		[`PASSWORD=<${V20}>`, V20],
		[`token = \`${V20}\``, V20],
		[`$env:API_KEY="${V32}"`, V32],
		[`set API_KEY=${V32}`, V32],
		[`"password":\n  "${V20}"`, V20],
	];
	for (const [input, secret] of cases)
		it(`hides: ${input.slice(0, 40)}`, () => {
			expectHidden(input, secret);
		});

	it("redacts a YAML block scalar under a secret-named key and keeps the next key", () => {
		const out = scrub(`db:\n  private_key: |\n    ${V32}\n    ${V44}\n  host: x\n`);
		expect(out.scrubbed).not.toContain(V32);
		expect(out.scrubbed).not.toContain(V44);
		expect(out.scrubbed).toContain("  host: x");
		expect(out.scrubbed).toContain("private_key: |");
	});
});

describe("SecretScanner - 8SO: extra provider shapes", () => {
	const cases: [string, string, string][] = [
		[
			"azure conn str",
			`DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${V64}==;EndpointSuffix=core.windows.net`,
			V64,
		],
		["azure SAS sig", `https://x.blob.core.windows.net/c?sv=2020&sig=${V44}%3D&se=2030`, V44],
		[
			"azure SharedAccessKey",
			`Endpoint=sb://x/;SharedAccessKeyName=r;SharedAccessKey=${V44}=`,
			V44,
		],
		["google ya29", `access ya29.${rand(60, URLSAFE, 35)}`, rand(60, URLSAFE, 35)],
		["npm", `//registry.npmjs.org/:_authToken=npm_${rand(36, ALNUM, 36)}`, rand(36, ALNUM, 36)],
		["npm bare", `npm_${rand(36, ALNUM, 37)}`, rand(36, ALNUM, 37)],
		["huggingface", `hf_${rand(34, ALNUM, 38)}`, rand(34, ALNUM, 38)],
		["groq", `gsk_${rand(52, ALNUM, 39)}`, rand(52, ALNUM, 39)],
		["xai", `xai-${rand(80, ALNUM, 40)}`, rand(80, ALNUM, 40)],
		["google oauth secret", `GOCSPX-${rand(28, URLSAFE, 41)}`, rand(28, URLSAFE, 41)],
		["sendgrid", `SG.${rand(22, URLSAFE, 42)}.${rand(43, URLSAFE, 43)}`, rand(43, URLSAFE, 43)],
		["twilio", `SK${rand(32, HEX, 44)}`, rand(32, HEX, 44)],
		[
			"slack webhook",
			`https://hooks.slack.com/services/T${rand(8, ALNUM, 45)}/B${rand(8, ALNUM, 46)}/${rand(24, ALNUM, 47)}`,
			rand(24, ALNUM, 47),
		],
	];
	for (const [label, input, secret] of cases)
		it(`hides ${label}`, () => {
			expectHidden(input, secret);
		});
});

describe("SecretScanner - 8SO: false positives stay untouched", () => {
	const negatives = [
		"const token = getToken();",
		"password: await hash(input),",
		"secret: z.string().min(8),",
		"  password: string;\n  apiKey: string;\n  token?: string;",
		"const apiKey = process.env.OPENAI_API_KEY;",
		"password: process.env.DB_PASSWORD,",
		"apiKey: config.apiKey,",
		"auth_url=https://example.com/login",
		"TOKEN_URL=https://auth.example.com/oauth/token",
		"DOC_AUTH=docs/auth.md",
		"auth=oauth2",
		"key=value&other=1",
		"cache_key=build-linux-x64-abc123def456",
		"CACHE_KEY=node-modules-8f3a9c1e2b7d",
		"TOKEN=$(cat x)",
		"PASSWORD=$(op read op://vault/db/password)",
		"sk-learn-pipeline-stage-one-transform",
		"sk-1-column-layout-wrapper-class",
		"tailwind class: sk-button-primary-2xl-large-variant",
		"headers: { Authorization: `Bearer ${token}` }",
		"Authorization: Bearer ${TOKEN}",
		"AuthorizationError: not allowed",
		"public_key: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnopqrstuvwxyz0123456789 user@host",
		"private: true",
		'"private": true,',
		"url: https://host:8080/path@v2",
		"ssh://git@github.com/a/b",
		"max_tokens: 4096",
		"token_count=12345678",
		"Password:",
		"password: yes",
		"PASSWORD=none",
		"SharedAccessKeyName=RootManageSharedAccessKey",
		"tokenizer: gpt2",
		"monkey=banana",
	];
	for (const line of negatives) {
		it(`leaves alone: ${line.slice(0, 40)}`, () => {
			expect(scrub(line).scrubbed).toBe(line);
		});
	}
});

describe("SecretScanner - 8SO: ReDoS and input cap", () => {
	const MB = 1024 * 1024;
	for (const [label, unit] of [
		["a.", "a."],
		["a-", "a-"],
		["key-", "key-"],
		["key.", "key."],
		["a+ before ://", "a+"],
	] as const) {
		it(`1 MB of "${label}" in under 200 ms`, () => {
			const input = unit.repeat(Math.ceil(MB / unit.length));
			const start = performance.now();
			scrub(input);
			expect(performance.now() - start).toBeLessThan(200);
		});
	}

	it("fails closed past the 2 MB cap", () => {
		const input = `${"x ".repeat(MB)}PASSWORD=${V20}`;
		const out = scrub(input);
		expect(out.scrubbed).not.toContain(V20);
		expect(out.scrubbed).toContain("[REDACTED:input_cap]");
		expect(out.rules).toContain("input_cap");
	});
});

// 8SO round 3 on #4018 (#3203).
describe("SecretScanner - 8SO round 3", () => {
	const V = "Zq9xLm2pRt7vWk4nBc8dJQX4bipwDKRY";

	it("dotted, path and URL exemptions still check each segment", () => {
		for (const input of [
			`API_KEY=${V}.${V}`,
			`API_KEY=/${V}`,
			`API_TOKEN=https://x/?k=${V}`,
			`DB_PASSWORD=/etc/${V}`,
		]) {
			expectHidden(input, V);
		}
		for (const input of [
			"const apiKey = process.env.OPENAI_API_KEY;",
			"API_KEY=/etc/secret/key",
			"auth_url=https://example.com/login?next=/home",
		]) {
			expect(scrub(input).scrubbed).toBe(input);
		}
	});

	it("redacts a value longer than the scan window to the end of the token", () => {
		const long = `${"a".repeat(5000)}SECRETTAIL`;
		const out = scrub(`PASSWORD=${long} next`).scrubbed;
		expect(out).not.toContain("SECRETTAIL");
		expect(out).not.toContain("aaaa");
		const q = scrub(`API_KEY="${"b1".repeat(3000)}TAIL"`).scrubbed;
		expect(q).not.toContain("TAIL");
	});

	// 8SO ruling (#4018 review): key/token names need 16+ chars or a
	// letter/digit mix, so short numeric values such as counts and PINs-looking
	// ids are intentionally kept. Password, passwd, pwd and secret names always redact.
	it("pins the short-value rule for key/token names", () => {
		expectHidden("TOKEN=abc12345", "abc12345");
		expect(scrub("TOKEN=123456").scrubbed).toBe("TOKEN=123456");
		expectHidden("SECRET_KEY=short1", "short1");
	});

	it("redacts a Discord bot token", () => {
		// Assembled at runtime so push protection does not flag a fake token.
		const tok = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GhYtRe", "abcdefghijklmnopqrstuvwxyz1"].join(".");
		const out = scrub(`discord ${tok}`);
		expect(out.scrubbed).toBe("discord [REDACTED:discord_token]");
	});
});

describe("scrubKeepingAttachment (#4295)", () => {
	const MARKER = "[image-attachment]";
	// ~3 MB of base64, over MAX_SCAN_CHARS. Deterministic, base64 alphabet only.
	const b64 = "iVBORw0KGgo".repeat(280_000).slice(0, 3_000_000);
	const line = `${MARKER} data:image/png;base64,${b64}`;

	it("keeps a 3 MB harness attachment byte for byte and still a valid data URL", () => {
		expect(line.length).toBeGreaterThan(MAX_SCAN_CHARS);
		const out = scrubKeepingAttachment(`{"width":1024}\n${line}`, MARKER);
		expect(out.scrubbed).toBe(`{"width":1024}\n${line}`);
		expect(out.scrubbed).not.toContain("input_cap");
		const url = out.scrubbed.split("\n")[1].slice(MARKER.length + 1);
		expect(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)).toBe(true);
	});

	it("still redacts a secret in the surrounding text", () => {
		const out = scrubKeepingAttachment(`note PASSWORD=hunter2hunter2\n${line}`, MARKER);
		expect(out.scrubbed).not.toContain("hunter2hunter2");
		expect(out.redactedCount).toBeGreaterThan(0);
		expect(out.scrubbed.endsWith(line)).toBe(true);
	});

	it("scans a look-alike attachment line injected by tool output", () => {
		// Not the final line: scanned, and the oversized text is capped as before.
		const fake = `${MARKER} data:image/png;base64,${b64}\nPASSWORD=hunter2hunter2\n${line}`;
		const early = scrubKeepingAttachment(fake, MARKER);
		expect(early.scrubbed).not.toContain("hunter2hunter2");
		// Final line that smuggles text instead of pure base64: scanned in full.
		const text = `${MARKER} data:image/png;base64,AAAA PASSWORD=hunter2hunter2`;
		const smuggle = scrubKeepingAttachment(`x\n${text}`, MARKER);
		expect(smuggle.scrubbed).not.toContain("hunter2hunter2");
		// Wrong mime or marker is not exempt either.
		const big = `y\n${MARKER} data:text/html;base64,${b64}`;
		expect(scrubKeepingAttachment(big, MARKER).scrubbed).toContain("[REDACTED:input_cap]");
	});

	it("does not exempt an svg+xml attachment line", () => {
		const svg = `x\n${MARKER} data:image/svg+xml;base64,${b64}`;
		expect(scrubKeepingAttachment(svg, MARKER).scrubbed).toContain("[REDACTED:input_cap]");
	});

	it("falls back to the full scrub above the attachment length bound", () => {
		const over = "A".repeat(MAX_ATTACHMENT_BASE64_CHARS + 1);
		const out = scrubKeepingAttachment(`x\n${MARKER} data:image/png;base64,${over}`, MARKER);
		expect(out.scrubbed).toContain("[REDACTED:input_cap]");
		const ok = scrubKeepingAttachment(`x\n${MARKER} data:image/jpeg;base64,${b64}`, MARKER);
		expect(ok.scrubbed).not.toContain("input_cap");
	});
});
