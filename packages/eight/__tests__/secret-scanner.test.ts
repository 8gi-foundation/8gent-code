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
import { scrub } from "../secret-scanner";

describe("SecretScanner — AWS access key id", () => {
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

describe("SecretScanner — GCP API key", () => {
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

describe("SecretScanner — Anthropic API key", () => {
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

	it("does NOT redact a key missing the AA suffix", () => {
		const out = scrub(`sk-ant-api03-${"a".repeat(93)}XX`);
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact sk-ant-api01 (wrong version)", () => {
		const out = scrub(`sk-ant-api01-${"a".repeat(93)}AA`);
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact a too-short body", () => {
		const out = scrub(`sk-ant-api03-${"a".repeat(20)}AA`);
		expect(out.redactedCount).toBe(0);
	});
});

describe("SecretScanner — OpenAI API key", () => {
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

	it("does NOT redact a too-short suffix after T3BlbkFJ", () => {
		const out = scrub(`sk-${a}T3BlbkFJ${"y".repeat(5)}`);
		expect(out.redactedCount).toBe(0);
	});
});

describe("SecretScanner — DigitalOcean PAT", () => {
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

describe("SecretScanner — GitHub tokens", () => {
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

	it("does NOT redact gho_ prefix (different token type, not in scope)", () => {
		const out = scrub(`gho_${"a".repeat(36)}`);
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact ghp_ with hyphen (invalid char)", () => {
		const out = scrub(`ghp_${"a".repeat(17)}-${"b".repeat(18)}`);
		expect(out.redactedCount).toBe(0);
	});
});

describe("SecretScanner — Slack bot/user tokens", () => {
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

	it("does NOT redact xoxa- (legacy auth, not in scope)", () => {
		const out = scrub(`xoxa-${"1".repeat(30)}`);
		expect(out.redactedCount).toBe(0);
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

describe("SecretScanner — high-entropy adjacent-keyword (best-effort)", () => {
	it("redacts a high-entropy string after api_key=", () => {
		const out = scrub(`api_key=R7g!q3xZw9PvL2hN8jM4kB6yT5sH1cV0eA8oXkJzWqUbDfGrSnEcLtY`);
		expect(out.scrubbed).toContain("[REDACTED:entropy_keyword]");
		expect(out.redactedCount).toBeGreaterThanOrEqual(1);
	});

	it("redacts a high-entropy string after secret:", () => {
		const out = scrub(`secret: aZ1bY2cX3dW4eV5fU6gT7hS8iR9jQ0kP_lO-mN+oM=pL`);
		expect(out.scrubbed).toContain("[REDACTED:entropy_keyword]");
	});

	it("redacts a high-entropy string after password=", () => {
		const out = scrub(`password=Xy7Pq2!nV9$mZ8&kL4@jH3#gF6%dC1*rT0wEsBnQ`);
		expect(out.scrubbed).toContain("[REDACTED:entropy_keyword]");
	});

	it("does NOT redact low-entropy string after api_key=", () => {
		const out = scrub(`api_key=hello_world_test_value_with_low_entropy_repeating`);
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact short string adjacent to keyword", () => {
		const out = scrub(`api_key=short`);
		expect(out.redactedCount).toBe(0);
	});

	it("does NOT redact high-entropy string with no adjacent keyword", () => {
		const out = scrub(`R7g!q3xZw9PvL2hN8jM4kB6yT5sH1cV0eA8oXkJzWqUbDfGrSnEcLtY`);
		expect(out.redactedCount).toBe(0);
	});
});

describe("SecretScanner — mixed and edge", () => {
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

describe("SecretScanner — performance", () => {
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
