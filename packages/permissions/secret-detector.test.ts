/**
 * no-secrets-in-files: block credential SHAPES, not credential WORDS.
 *
 * Regression: Rishi's pilot (2026-09-29, l2-solo-deck) had write_file of a
 * Markdown slide outline blocked by [no-secrets-in-files]. The old rule was a
 * case-insensitive substring match, and the outline said "secret-to-network"
 * and "answer-token mapping". The fixture is the exact write_file args.
 *
 * Test secrets are assembled at runtime so no credential-shaped literal sits
 * in the repo (and push protection has nothing to flag).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.EIGHT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "secret-detector-test-"));

const { detectSecrets, hasSecret } = await import("./secret-detector");
const { evaluatePolicy } = await import("./policy-engine");
const { ToolExecutor } = await import("../eight/tools");

const PILOT = JSON.parse(
	fs.readFileSync(
		path.join(import.meta.dir, "__tests__/fixtures/pilot-deck-outline.json"),
		"utf-8",
	),
) as { path: string; content: string };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "secret-detector-ws-"));

function write(content: string, file = "notes.md") {
	return evaluatePolicy("write_file", {
		path: path.join(WS, file),
		content,
		workingDirectory: WS,
	});
}

// Runtime-assembled fake credentials. None of these are real.
const j = (...parts: string[]) => parts.join("");
const AWS_KEY_ID = j("AK", "IA", "Q3VZ7N2KXW5JTR8M");
const AWS_SECRET = j("wJalrXUt", "nFEMI/K7MDENG/", "bPxRfiCY", "Zq8Rk2Lm", "Tp4v");
const GH_PAT = j("gh", "p_", "R7xkQ2mLp9vT4nWz8bYc3Hd6Fj1Ks5Ga0Ue2");
const SK_KEY = j("s", "k-", "proj-", "Xy7Qm2Lp9Rt4Vn8Kc3Wd6Fh1Js5Ba0Ge");
const PEM_BODY = j(
	"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj",
	"AgEAAoIBAQC7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1",
);
const PEM = `-----BEGIN ${"PRIVATE"} KEY-----\n${PEM_BODY}\n-----END ${"PRIVATE"} KEY-----\n`;
const HIGH_ENTROPY = j("q8Zr", "T2vLx9", "Mw4Kp7Nb", "3Yc6Hd1Fs");

describe("pilot regression: the exact outline that was blocked", () => {
	test("fixture is the real args (guards against a silently edited fixture)", () => {
		expect(PILOT.path).toBe("deck/outline.md");
		expect(PILOT.content.length).toBe(2262);
		expect(PILOT.content).toContain("secret-to-network");
		expect(PILOT.content).toContain("answer-token mapping");
	});

	test("detector finds no secret in the outline", () => {
		expect(detectSecrets(PILOT.content)).toEqual([]);
	});

	test("write_file of the outline is allowed by the policy engine", () => {
		const d = write(PILOT.content, PILOT.path);
		expect(d.allowed).toBe(true);
	});
});

describe("prose and docs that mention credential words are allowed", () => {
	const docs = [
		"Set your API_KEY in .env and read it with process.env.API_KEY.",
		"Never commit a SECRET. Rotate the TOKEN every 90 days. PASSWORD must be 12+ chars.",
		"## Auth\nThe PRIVATE_KEY is loaded from the keychain at runtime.",
		"const apiKey = process.env.OPENAI_API_KEY;",
		'token: string;\naccessToken: AccessTokenType;\nmax_tokens: 4096\nTOKEN_TYPE = "bearer"',
		'api_key: "YOUR_API_KEY_HERE"\npassword: "changeme"\nsecret = "${SECRET}"',
		"postgres://user:password@localhost:5432/app",
		"Tokenizer maps each answer-token to a logprob; the secret-to-network rule fires.",
		"-----BEGIN PRIVATE KEY----- is the header of a PKCS#8 key.",
		"Use scikit sk-learn-compatible-wrapper-for-models here.",
		"AWS documents its example key id as AKIAIOSFODNN7EXAMPLE.",
		"const token = header.slice(7);\nconst apiKey = trimmed.slice(14).trim();\nconst token = vault.get(name);",
		'const apiKey = "lm-studio";\nconst telegramToken = "test-token";\nconst TOKEN = /^[a-z0-9-]+$/;',
	];
	for (const doc of docs) {
		test(`allowed: ${JSON.stringify(doc.slice(0, 50))}`, () => {
			expect(detectSecrets(doc)).toEqual([]);
			expect(write(doc).allowed).toBe(true);
		});
	}
});

describe("realistic secrets are still blocked", () => {
	const cases: Array<[string, string, string]> = [
		[
			"AWS key id + secret",
			`[default]\naws_access_key_id = ${AWS_KEY_ID}\naws_secret_access_key = ${AWS_SECRET}\n`,
			"aws-access-key-id",
		],
		["GitHub PAT", `GITHUB_TOKEN=${GH_PAT}`, "github-token"],
		["sk- style key", `const client = new OpenAI({ apiKey: "${SK_KEY}" });`, "sk-api-key"],
		["PEM private key block", PEM, "pem-private-key"],
		[
			"high-entropy value in a KEY var",
			`export STRIPE_SECRET_KEY="${HIGH_ENTROPY}"`,
			"secret-assignment",
		],
		[
			"high-entropy value in a TOKEN var (.env, unquoted)",
			`SLACK_BOT_TOKEN=${HIGH_ENTROPY}`,
			"secret-assignment",
		],
		[
			"high-entropy value in a JSON secret field",
			`{ "client_secret": "${HIGH_ENTROPY}" }`,
			"secret-assignment",
		],
		[
			"credentials in a URL",
			`DATABASE_URL=postgres://app:${HIGH_ENTROPY}@db.internal:5432/app`,
			"url-credentials",
		],
	];
	for (const [label, content, id] of cases) {
		test(`blocked: ${label}`, () => {
			expect(detectSecrets(content)).toContain(id);
			const d = write(content, "config.ts");
			expect(d.allowed).toBe(false);
			if (!d.allowed) expect(d.reason).toContain("[no-secrets-in-files]");
		});
	}

	test("the AWS secret is caught on its own by the assignment rule", () => {
		expect(detectSecrets(`aws_secret_access_key = ${AWS_SECRET}`)).toContain("secret-assignment");
	});

	test("a secret buried in a long Markdown doc is still caught", () => {
		expect(hasSecret(`${PILOT.content}\n\nOPENAI_API_KEY=${SK_KEY}\n`)).toBe(true);
	});
});

describe("robustness", () => {
	test("large input with no secret scans quickly", () => {
		const big = "token secret password api_key ".repeat(20_000) + "a".repeat(200_000);
		const t0 = performance.now();
		expect(detectSecrets(big)).toEqual([]);
		expect(performance.now() - t0).toBeLessThan(1000);
	});

	test("empty and non-string content is not a secret", () => {
		expect(detectSecrets("")).toEqual([]);
		expect(detectSecrets(undefined as unknown as string)).toEqual([]);
	});
});

describe("ToolExecutor.execute - the real write_file path", () => {
	test("the pilot outline is actually written to disk", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-exec-"));
		const exec = new ToolExecutor(dir, "primary");
		const out = await exec.execute("write_file", { path: PILOT.path, content: PILOT.content });
		expect(out).not.toContain("[TOOLG8 BLOCKED]");
		expect(fs.readFileSync(path.join(dir, PILOT.path), "utf-8")).toBe(PILOT.content);
	});

	test("a blocked secret write says plainly the file was NOT written, and it was not", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-exec-"));
		const exec = new ToolExecutor(dir, "primary");
		const out = await exec.execute("write_file", {
			path: "config.ts",
			content: `export const key = "${SK_KEY}";\n`,
		});
		expect(out).toStartWith("[TOOLG8 BLOCKED] write_file did NOT run.");
		expect(out).toContain("The file config.ts was NOT written.");
		expect(out).toContain("[no-secrets-in-files]");
		// The generic "use edit_file" hint must not be offered for a secrets block.
		expect(out).not.toContain("edit_file");
		expect(fs.existsSync(path.join(dir, "config.ts"))).toBe(false);
	});
});
