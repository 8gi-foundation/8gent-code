import { describe, expect, test } from "bun:test";
import { redact } from "./redact";

const OPENAI_CLASSIC = `sk-${"A1b2C3d4".repeat(4)}`;
const OPENAI_PROJ = `sk-proj-${"Ab12_Cd34-Ef56".repeat(3)}`;
const OPENAI_SVC = `sk-svcacct-${"Zz9_Yy8-Xx7".repeat(3)}`;
const OPENAI_ADMIN = `sk-admin-${"Qq1Ww2Ee3Rr4".repeat(2)}`;
const ANTHROPIC = `sk-ant-api03-${"Mm5Nn6_Oo7-Pp8".repeat(3)}`;
const STRIPE = [
	`sk_live_${"Ab12Cd34Ef56".repeat(2)}`,
	`rk_live_${"Gh78Ij90Kl12".repeat(2)}`,
	`sk_test_${"Mn34Op56Qr78".repeat(2)}`,
	`rk_test_${"St90Uv12Wx34".repeat(2)}`,
];
const BEARER = `eW91ci10b2tlbi${"1hYmMxMjM0NTY3".repeat(2)}.x~y+z/w=`;

describe("redact: key shapes", () => {
	test("classic OpenAI key", () => {
		const out = redact(`key ${OPENAI_CLASSIC} here`);
		expect(out).toBe("key [REDACTED_OPENAI_KEY] here");
	});

	for (const [name, key] of [
		["sk-proj-", OPENAI_PROJ],
		["sk-svcacct-", OPENAI_SVC],
		["sk-admin-", OPENAI_ADMIN],
	] as const) {
		test(`OpenAI ${name} key is redacted whole`, () => {
			const out = redact(`use \`${key}\` for this`);
			expect(out).toBe("use `[REDACTED_OPENAI_KEY]` for this");
		});
	}

	test("an Anthropic key keeps its own label", () => {
		expect(redact(`k=${ANTHROPIC}`)).toBe("k=[REDACTED_ANTHROPIC_KEY]");
	});

	test("Bearer token", () => {
		expect(redact(`Authorization: Bearer ${BEARER}`)).toBe(
			"Authorization: Bearer [REDACTED_BEARER_TOKEN]",
		);
		expect(redact(`authorization: bearer ${BEARER}`)).not.toContain(BEARER);
	});

	for (const key of STRIPE) {
		test(`Stripe ${key.slice(0, 8)} key`, () => {
			expect(redact(`STRIPE=${key};`)).toBe("STRIPE=[REDACTED_STRIPE_KEY];");
		});
	}

	test("credentials inside a URL", () => {
		expect(redact("postgres://admin:hunter2pass@db.internal:5432/app")).toBe(
			"postgres://[REDACTED_URL_CREDENTIALS]@db.internal:5432/app",
		);
		expect(redact("clone https://james:ghs-secret-value@example.com/repo.git now")).toBe(
			"clone https://[REDACTED_URL_CREDENTIALS]@example.com/repo.git now",
		);
	});
});

describe("redact: leaves ordinary text alone", () => {
	for (const text of [
		"the risk-assessment-framework-documentation is in docs/",
		"task-management-and-planning-tools",
		"see src/memory/redact.ts and packages/kernel/judge.ts",
		"the sk- prefix marks an OpenAI key",
		"an sk-short value",
		"https://example.com/path?q=1#frag",
		"http://localhost:8080/health",
		"ssh://git@github.com/org/repo.git",
		"mailto:someone@example.com",
		"the bearer of bad news",
		"Bearer short",
		"desk_live_session and risk_test_case",
		"a_live_wire and sk_live_short",
		"port 4180, APP_MODE=staging",
	]) {
		test(JSON.stringify(text), () => {
			expect(redact(text)).toBe(text);
		});
	}
});

describe("redact: bounded time", () => {
	test("long hostile inputs stay fast", () => {
		const inputs = [
			`${"sk-".repeat(50_000)}`,
			`Bearer ${"a".repeat(200_000)}`,
			`${"://a:b".repeat(30_000)}`,
			`://${"x".repeat(100_000)}:${"y".repeat(100_000)}`,
			`${"sk_live_".repeat(30_000)}`,
		];
		const t0 = performance.now();
		for (const s of inputs) redact(s);
		expect(performance.now() - t0).toBeLessThan(500);
	});
});
