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
import { commandTouchesAuditFiles, validatePath } from "../permissions/path-guard";
import { evaluatePolicy } from "../permissions/policy-engine";
import {
	PROTECTED_DATA_FILES,
	buildBwrapArgs,
	buildRunCommandProfile,
	protectedRunCommandPaths,
	refreshSecurityEnvForTests,
} from "../permissions/run-command-sandbox";
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
	test("escaped JSON password keys inside a string (#247)", () => {
		const bs = "\\";
		const esc = (s: string) => s.replaceAll('"', `${bs}"`);
		expect(redact(esc(`{"password":"x"}`))).toBe(esc(`{"password":"[REDACTED_SECRET]"}`));
		expect(redact(esc(`{"db_password" : "correct horse"}`))).toBe(
			esc(`{"db_password" : "[REDACTED_SECRET]"}`),
		);
		const nested = `{"msg":"${esc(`{"password":"hunter2","user":"a"}`)}"}`;
		const out = redact(nested);
		expect(out).not.toContain("hunter2");
		expect(out).toBe(`{"msg":"${esc(`{"password":"[REDACTED_SECRET]","user":"a"}`)}"}`);
		// an escaped backslash inside the value does not end it early
		expect(redact(`${bs}"password${bs}":${bs}"a${bs}${bs}b c${bs}"`)).toBe(
			`${bs}"password${bs}":${bs}"[REDACTED_SECRET]${bs}"`,
		);
		// an empty escaped value is left as it is
		expect(redact(esc(`{"password":""}`))).toBe(esc(`{"password":""}`));
	});
	test("an escaped quote inside the value does not end it early (8SO on #249)", () => {
		const bs = "\\";
		// escaped JSON whose value holds its own quote: \"hun\\\"ter2\"
		const inEscaped = `${bs}"password${bs}":${bs}"hun${bs}${bs}${bs}"ter2${bs}"`;
		expect(redact(inEscaped)).toBe(`${bs}"password${bs}":${bs}"[REDACTED_SECRET]${bs}"`);
		expect(redact(inEscaped)).not.toContain("ter2");
		// plain JSON whose value holds an escaped quote: {"password":"a\"b"}
		const plain = `{"password":"a${bs}"b","user":"u"}`;
		expect(redact(plain)).toBe(`{"password":"[REDACTED_SECRET]","user":"u"}`);
		// a value that ends in its own backslash still stops at the real close
		expect(redact(`{"password":"ab${bs}${bs}","user":"u"}`)).toBe(
			`{"password":"[REDACTED_SECRET]","user":"u"}`,
		);
		expect(
			redact(`${bs}"password${bs}":${bs}"ab${bs}${bs}${bs}${bs}${bs}", ${bs}"user${bs}":${bs}"u${bs}"`),
		).toBe(`${bs}"password${bs}":${bs}"[REDACTED_SECRET]${bs}", ${bs}"user${bs}":${bs}"u${bs}"`);
	});
	test("the password rule stays linear on 400k characters", () => {
		const bs = "\\";
		const n = 400_000;
		const inputs = [
			`${bs}"password${bs}":${bs}"${"a".repeat(n)}`,
			`${bs}"password${bs}":${bs}"${`a${bs}`.repeat(n / 2)}`,
			`${bs}"password${bs}":${bs}"`.repeat(n / 14),
			`${bs}"password${bs}":${bs}"${bs.repeat(n)}`,
			`${bs}"password${bs}":${bs}"${`${bs}${bs}${bs}"`.repeat(n / 4)}`,
			`"password":"${"a".repeat(n)}`,
			`"password":"${bs.repeat(n)}`,
			`"password":"${`${bs}"`.repeat(n / 2)}`,
			"password:".repeat(n / 9),
			bs.repeat(n),
		];
		for (const s of inputs) {
			const t0 = performance.now();
			redact(s);
			expect(performance.now() - t0).toBeLessThan(250);
		}
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

describe("#247 run_command: learned.jsonl under ~/.8gent and the data dir", () => {
	const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lj-data-"));
	const EIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lj-eighthome-"));
	const saved = { data: process.env.EIGHT_DATA_DIR, home: process.env.EIGHT_HOME };
	beforeAll(() => {
		process.env.EIGHT_DATA_DIR = DATA_DIR;
		process.env.EIGHT_HOME = EIGHT_HOME;
	});
	afterAll(() => {
		if (saved.data === undefined) delete process.env.EIGHT_DATA_DIR;
		else process.env.EIGHT_DATA_DIR = saved.data;
		if (saved.home === undefined) delete process.env.EIGHT_HOME;
		else process.env.EIGHT_HOME = saved.home;
		for (const d of [DATA_DIR, EIGHT_HOME]) fs.rmSync(d, { recursive: true, force: true });
	});
	// forward slashes: an unquoted backslash path is an escape sequence to the command parser
	const slash = (p: string) => p.split(path.sep).join("/");
	const targets = [
		"~/.8gent/learned.jsonl",
		"$HOME/.8gent/learned.jsonl",
		"~/'.8gent'/'learned'.jsonl",
		`${slash(DATA_DIR)}/learned.jsonl`,
		// EIGHT_HOME is the home folder (packages/core/home.ts), so the record sits under .8gent there
		`${slash(EIGHT_HOME)}/.8gent/learned.jsonl`,
		// dot segments are collapsed before matching (8SO on #249)
		"~/.8gent/./learned.jsonl",
		"~/.8gent/x/../learned.jsonl",
		"~/a/b/../../.8gent/./x/y/../../learned.jsonl",
		`${slash(DATA_DIR)}/./sub/../learned.jsonl`,
	];
	const forms = (t: string) => [
		`rm ${t}`,
		`rm -f ${t}`,
		`truncate -s 0 ${t}`,
		`: > ${t}`,
		`echo '{"lesson":"x"}' >> ${t}`,
		`echo x | tee ${t}`,
		`echo x | tee -a ${t}`,
		`mv /tmp/x.jsonl ${t}`,
		`cp /tmp/x.jsonl ${t}`,
	];
	for (const t of targets) {
		for (const cmd of forms(t)) {
			test(`denies: ${cmd}`, () => {
				expect(commandTouchesAuditFiles(cmd)).toBe(true);
				const d = evaluatePolicy("run_command", { command: cmd, cwd: PROJ, workingDirectory: PROJ });
				expect(d.allowed).toBe(false);
			});
		}
	}
	for (const cmd of [
		"rm learned.jsonl",
		"echo x >> learned.jsonl",
		`rm ${slash(path.join(PROJ, "learned.jsonl"))}`,
		"cp a.jsonl ./data/learned.jsonl",
		"rm ~/.8gent/../learned.jsonl",
		`rm ${slash(EIGHT_HOME)}/learned.jsonl`,
		"ls src",
		"git status",
	]) {
		test(`does not flag: ${cmd}`, () => {
			expect(commandTouchesAuditFiles(cmd)).toBe(false);
		});
	}
});

describe("#247 run_command OS sandbox: learned.jsonl is a protected data file (8SO on #249)", () => {
	test("in PROTECTED_DATA_FILES, the protected paths, the Seatbelt profile and the bwrap binds", () => {
		const saved = { data: process.env.EIGHT_DATA_DIR, home: process.env.EIGHT_HOME };
		delete process.env.EIGHT_DATA_DIR;
		delete process.env.EIGHT_HOME;
		refreshSecurityEnvForTests();
		try {
			expect(PROTECTED_DATA_FILES).toContain("learned.jsonl");
			const p = protectedRunCommandPaths();
			expect(p.files).toContain(LEARNED);
			expect(buildRunCommandProfile(p)).toContain(LEARNED);
			const args = buildBwrapArgs(p);
			const i = args.indexOf(LEARNED);
			expect(i).toBeGreaterThan(0);
			expect(args[i - 1]).toBe("--ro-bind");
		} finally {
			if (saved.data !== undefined) process.env.EIGHT_DATA_DIR = saved.data;
			if (saved.home !== undefined) process.env.EIGHT_HOME = saved.home;
			refreshSecurityEnvForTests();
		}
	});
});
