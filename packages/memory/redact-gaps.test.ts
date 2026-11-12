/**
 * #243: token shapes redact() missed, and learned.jsonl as a protected home file.
 *
 * Sample tokens are built at run time so no literal token sits in the source.
 * The path guard runs against a fake HOME in the temp dir; the real ~/.8gent is
 * never read or written.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validatePath } from "../permissions/path-guard";
import { evaluatePolicy } from "../permissions/policy-engine";
import { redact } from "./redact";

const GOOGLE = `AIza${"Sy9_xQ-2bK".repeat(3)}${"Lm4pT"}`; // 4 + 35
const HF = `hf_${"AbCdEfGhIjKlMnOpQ".repeat(2)}`; // 3 + 34
const GITHUB = ["gho", "ghu", "ghr", "ghp", "ghs"].map((p) => `${p}_${"Ab3De6Gh9J".repeat(4)}`);
const GITLAB = `glpat-${"Xy7_Zw-3Qr".repeat(2)}`; // 6 + 20
const GITLAB_ROUTABLE = `glpat-${"Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr".repeat(2)}.01.${"a1b2c3d4e"}`;
const NPM = `npm_${"Ab12Cd34Ef56".repeat(3)}`; // 4 + 36

describe("#243 redact: new token shapes are removed", () => {
	test("Google API key", () => {
		expect(GOOGLE.length).toBe(39);
		expect(redact(`maps key ${GOOGLE} here`)).toBe("maps key [REDACTED_GOOGLE_API_KEY] here");
	});
	test("Hugging Face token", () => {
		expect(HF.length).toBe(37);
		expect(redact(`login with ${HF}.`)).toBe("login with [REDACTED_HF_TOKEN].");
	});
	for (const t of GITHUB) {
		test(`GitHub ${t.slice(0, 4)} token`, () => {
			expect(redact(`use ${t} now`)).toBe("use [REDACTED_GITHUB_TOKEN] now");
		});
	}
	test("GitLab personal access token, classic and routable", () => {
		expect(redact(`push with ${GITLAB}.`)).toBe("push with [REDACTED_GITLAB_TOKEN].");
		expect(redact(`push with ${GITLAB_ROUTABLE} ok`)).toBe("push with [REDACTED_GITLAB_TOKEN] ok");
	});
	test("npm token", () => {
		expect(NPM.length).toBe(40);
		expect(redact(`//registry.npmjs.org/:_authToken=${NPM}`)).not.toContain(NPM);
		expect(redact(`publish with ${NPM} then`)).toBe("publish with [REDACTED_NPM_TOKEN] then");
	});
	test("lowercase and mixed case password= and password:", () => {
		expect(redact("password=hunter2")).toBe("password=[REDACTED_SECRET]");
		expect(redact("password: hunter2")).toBe("password: [REDACTED_SECRET]");
		expect(redact("db_password = 's3cret'")).toBe("db_password = '[REDACTED_SECRET]'");
		expect(redact("Password:hunter2 and passwd=x9")).toBe(
			"Password:[REDACTED_SECRET] and passwd=[REDACTED_SECRET]",
		);
	});
	test("JSON password keys and quoted values with spaces", () => {
		expect(redact(`{"password":"x"}`)).toBe(`{"password":"[REDACTED_SECRET]"}`);
		expect(redact(`{"Password" : "a b c"}`)).toBe(`{"Password" : "[REDACTED_SECRET]"}`);
		expect(redact(`{"db_password":"x"}`)).toBe(`{"db_password":"[REDACTED_SECRET]"}`);
		expect(redact(`{"DB_PASSWORD":"x"}`)).toBe(`{"DB_PASSWORD":"[REDACTED_SECRET]"}`);
		expect(redact("password='a b'")).toBe("password='[REDACTED_SECRET]'");
		const out = redact(`password: "correct horse battery"`);
		expect(out).toBe(`password: "[REDACTED_SECRET]"`);
		expect(out).not.toContain("horse");
	});
	test("an upper case PASSWORD line is redacted once, not twice", () => {
		expect(redact("DB_PASSWORD=p4ss")).toBe("DB_PASSWORD=[REDACTED_SECRET]");
	});
});

describe("#243 redact: ordinary text near the new shapes is left alone", () => {
	for (const text of [
		"the AIza prefix marks a Google key, AIzaShort is not one",
		"hf_hub_download and hf_transfer are Hugging Face helpers",
		"call hf_downloadmodelfromthehubwithretriesandcache",
		"ghost_town and gho_short and ghr_ are not tokens",
		"glpat-short and glpat- prefix",
		"npm_config_registry and npm_lifecycle_event",
		"npm_short",
		"the password field is required",
		"passwordless: true",
		"reset your password then sign in",
		"monkey: banana, author: james, keyboard: yes",
	]) {
		test(JSON.stringify(text), () => {
			expect(redact(text)).toBe(text);
		});
	}
});

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lj-home-"));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), "lj-proj-"));
const LEARNED = path.join(FAKE_HOME, ".8gent", "learned.jsonl");
let savedWorkspaceRoot: string | undefined;

beforeAll(() => {
	process.env.EIGHT_FAKE_HOME = FAKE_HOME;
	savedWorkspaceRoot = process.env.EIGHT_WORKSPACE_ROOT;
	delete process.env.EIGHT_WORKSPACE_ROOT;
	fs.mkdirSync(path.join(FAKE_HOME, ".8gent"), { recursive: true });
	fs.writeFileSync(LEARNED, "");
});

afterAll(() => {
	delete process.env.EIGHT_FAKE_HOME;
	if (savedWorkspaceRoot !== undefined) process.env.EIGHT_WORKSPACE_ROOT = savedWorkspaceRoot;
	for (const d of [FAKE_HOME, PROJ]) fs.rmSync(d, { recursive: true, force: true });
});

describe("#243 path guard: ~/.8gent/learned.jsonl is protected", () => {
	test("validatePath refuses a write, by full path and by the ~ spelling", () => {
		expect(validatePath(LEARNED, PROJ).ok).toBe(false);
		expect(validatePath("~/.8gent/learned.jsonl", PROJ).ok).toBe(false);
	});
	test("validatePath refuses a dotdot route", () => {
		const p = path.join(PROJ, "..", path.basename(FAKE_HOME), ".8gent", "learned.jsonl");
		expect(validatePath(p, PROJ).ok).toBe(false);
	});
	for (const action of ["write_file", "edit_file", "delete_file"]) {
		test(`evaluatePolicy denies ${action} on learned.jsonl`, () => {
			const d = evaluatePolicy(action as never, {
				path: LEARNED,
				cwd: PROJ,
				workingDirectory: PROJ,
			});
			expect(d.allowed).toBe(false);
		});
	}
	test("a learned.jsonl inside the workspace and other home files stay writable", () => {
		expect(validatePath(path.join(PROJ, "learned.jsonl"), PROJ).ok).toBe(true);
		expect(validatePath(path.join(FAKE_HOME, ".8gent", "notes.md"), PROJ).ok).toBe(true);
	});
});
