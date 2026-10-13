/**
 * System One judge log (#3885): record shape, no command text on disk (every
 * known scrubber-miss payload from the #3886 review), memo hit/miss, raw
 * edges, timeout and error records, file modes, and that logging changes no
 * verdict.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_FLAG,
	SYSTEM_ONE_TIMEOUT_ENV,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";
import {
	commandHash,
	describeCommand,
	logSystemOneJudge,
	systemOneLogPath,
} from "./system-one-log";

afterAll(cleanupTempDirs);

class Stub implements DecideBackend {
	readonly name = "stub";
	readonly model = "stub-model";
	calls = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.calls++;
		const yes = request.state.includes("DANGER")
			? 0.95
			: request.state.includes("UNSURE")
				? 0.5
				: 0.001;
		return {
			answers: [
				{ id: request.questions[0].id, kind: "noul", probabilities: { yes }, confidence: 0.9 },
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

let dir: string;
let stub: Stub;
const ON = { [SYSTEM_ONE_FLAG]: "1", [SYSTEM_ONE_ALLOWLIST_FLAG]: "0" };
const saved = process.env.EIGHT_DATA_DIR;

function install(cacheSize: number): void {
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: stub, cacheSize }),
		askHuman: async () => null,
		calibrationDir: tempDir("sys1log-nocal-"),
	});
}

function lines(): any[] {
	const f = join(dir, "audit", "system-one.jsonl");
	return existsSync(f)
		? readFileSync(f, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l))
		: [];
}

beforeEach(() => {
	_resetSystemOne();
	stub = new Stub();
	dir = tempDir("sys1log-");
	process.env.EIGHT_DATA_DIR = dir;
});
afterEach(() => {
	if (saved === undefined) Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
	else process.env.EIGHT_DATA_DIR = saved;
});

// Every shape the review showed the old scrubbed preview leaking, plus recognised keys.
const SECRET_PAYLOADS: Array<{ cmd: string; secrets: string[] }> = [
	{ cmd: "FOO=hunter2 run", secrets: ["hunter2"] },
	{ cmd: "DB_PASSWORD=Sup3rSecretPw run", secrets: ["Sup3rSecretPw"] },
	{ cmd: "MYSECRETKEY=abc123def456 run", secrets: ["abc123def456"] },
	{
		cmd: "curl https://host/v1?access_token=abcdef1234567890abcdef",
		secrets: ["abcdef1234567890abcdef"],
	},
	{
		cmd: "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sigvalue' https://x",
		secrets: ["eyJhbGciOiJIUzI1NiJ9", "sigvalue"],
	},
	{
		cmd: "curl -H 'Authorization: Basic dXNlcjpwYXNzd29yZA==' https://x",
		secrets: ["dXNlcjpwYXNzd29yZA"],
	},
	{ cmd: "curl https://user:p4ssw0rd@host/x", secrets: ["p4ssw0rd"] },
	{ cmd: "curl -u admin:s3cretpass https://x", secrets: ["s3cretpass"] },
	{ cmd: "mysql -pMyPassw0rd db", secrets: ["MyPassw0rd"] },
	{ cmd: "cat <<EOF\nAPI_KEY=zzzzzzzz\nEOF", secrets: ["zzzzzzzz"] },
	{ cmd: 'FOO="two words hunter3 here" run', secrets: ["hunter3", "two words"] },
	{
		cmd: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		secrets: ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
	},
	{ cmd: "AKIAIOSFODNN7EXAMPLE", secrets: ["AKIAIOSFODNN7EXAMPLE"] },
	{ cmd: "AKIAIOSFODNN7EXAMPLE=1 run", secrets: ["AKIAIOSFODNN7EXAMPLE"] },
	{
		cmd: "ghp_abcdefghijklmnopqrstuvwxyz0123456789=1 run",
		secrets: ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
	},
];

describe("record helpers", () => {
	test("hash is stable 16 hex and differs per command", () => {
		expect(commandHash("a")).toMatch(/^[0-9a-f]{16}$/);
		expect(commandHash("a")).toBe(commandHash("a"));
		expect(commandHash("a")).not.toBe(commandHash("b"));
	});
	test("describeCommand: program, env names without values, argument count", () => {
		expect(describeCommand("TODO_FILE=smoke.json bun src/cli.ts add 'walk dog'")).toEqual({
			program: "bun",
			envNames: ["TODO_FILE"],
			argc: 3,
		});
		expect(describeCommand("A=1 B=2 /bin/ls -la")).toEqual({
			program: "ls",
			envNames: ["A", "B"],
			argc: 1,
		});
		expect(describeCommand("").program).toBe("?");
		expect(describeCommand('"quoted secret" x').program).toBe("?");
	});
	test("a secret used as an env NAME is logged as ?, a normal name is kept", () => {
		expect(describeCommand("AKIAIOSFODNN7EXAMPLE=1 run").envNames).toEqual(["?"]);
		expect(describeCommand("ghp_abcdefghijklmnopqrstuvwxyz0123456789=1 run").envNames).toEqual([
			"?",
		]);
		expect(describeCommand("lower=1 A_B=2 run").envNames).toEqual(["?", "A_B"]);
		expect(describeCommand(`${"A".repeat(33)}=1 run`).envNames).toEqual(["?"]);
	});
	test("log is off under bun test without EIGHT_DATA_DIR", () => {
		expect(systemOneLogPath({ NODE_ENV: "test" })).toBeNull();
		expect(systemOneLogPath({ EIGHT_DATA_DIR: "/x" })).toBe("/x/audit/system-one.jsonl");
	});
	test("the logger never throws, even on garbage input", () => {
		expect(() =>
			logSystemOneJudge({
				command: undefined as unknown as string,
				thresholds: "t",
				guard: null as never,
			}),
		).not.toThrow();
		const hostile = {
			toString() {
				throw new Error("x");
			},
		};
		expect(() => logSystemOneJudge({ command: hostile as never, thresholds: "t" })).not.toThrow();
	});
});

describe("gate writes one record per judge call", () => {
	test("shape, raw pYes, verdict, edges, backend/model, memo miss then hit", async () => {
		install(256);
		const cmd = "TODO_FILE=smoke.json bun src/cli.ts add 'UNSURE milk'";
		const a = await systemOneGate(cmd, ON);
		const b = await systemOneGate(cmd, ON);
		const recs = lines();
		expect(recs).toHaveLength(2);
		expect(Object.keys(recs[0]).sort()).toEqual(
			[
				"argc",
				"backend",
				"blockAbove",
				"envNames",
				"escalateHigh",
				"escalateLow",
				"hash",
				"memoHit",
				"model",
				"outcome",
				"pYes",
				"program",
				"thresholds",
				"timestamp",
				"verdict",
			].sort(),
		);
		expect(recs[0]).toMatchObject({
			outcome: "verdict",
			hash: commandHash(cmd),
			program: "bun",
			envNames: ["TODO_FILE"],
			argc: 3,
			pYes: 0.5,
			verdict: "escalate",
			escalateLow: 0.35,
			escalateHigh: 0.65,
			blockAbove: 0.5,
			backend: "stub",
			model: "stub-model",
			memoHit: false,
		});
		expect(recs[1].memoHit).toBe(true);
		expect(stub.calls).toBe(1);
		expect(a.run).toBe(b.run);
	});

	test("calibrated edges are the raw edges the verdict was cut with", async () => {
		const cal = tempDir("sys1log-cal-");
		writeFileSync(
			join(cal, "ollama-stub-model.json"),
			JSON.stringify({
				model: "stub-model",
				backend: "stub",
				n: 40,
				temperature: 1,
				bias: 0,
				blockAbove: 0.7,
				escalateBand: [0.3, 0.7],
			}),
		);
		_setSystemOneOverridesForTests({
			createDecider: () => createDecider({ backend: stub, cacheSize: 0 }),
			askHuman: async () => null,
			calibrationDir: cal,
		});
		await systemOneGate("echo UNSURE", ON);
		const r = lines()[0];
		expect(typeof r.escalateLow).toBe("number");
		expect(typeof r.escalateHigh).toBe("number");
		expect(typeof r.blockAbove).toBe("number");
		expect(r.escalateLow).toBeLessThanOrEqual(r.escalateHigh);
	});

	test("a judge error and a judge timeout are their own records, without messages", async () => {
		const failing = {
			name: "stub",
			model: "stub-model",
			ask: async () => {
				throw new Error("boom SECRETVALUE");
			},
		};
		_setSystemOneOverridesForTests({
			createDecider: () =>
				createDecider({ backend: failing as unknown as DecideBackend, cacheSize: 0 }),
			askHuman: async () => null,
			calibrationDir: tempDir("sys1log-nocal-"),
		});
		await systemOneGate("echo hi", ON);
		_resetSystemOne();
		const hanging = { name: "stub", model: "stub-model", ask: () => new Promise(() => {}) };
		_setSystemOneOverridesForTests({
			createDecider: () =>
				createDecider({ backend: hanging as unknown as DecideBackend, cacheSize: 0 }),
			askHuman: async () => null,
			calibrationDir: tempDir("sys1log-nocal-"),
		});
		await systemOneGate("echo hi", { ...ON, [SYSTEM_ONE_TIMEOUT_ENV]: "50" });
		const recs = lines();
		expect(recs.map((r) => r.outcome)).toContain("timeout");
		expect(readFileSync(join(dir, "audit", "system-one.jsonl"), "utf8")).not.toContain(
			"SECRETVALUE",
		);
		for (const r of recs.filter((r) => r.outcome !== "verdict")) {
			expect(r.pYes).toBeNull();
			expect(r.verdict).toBeNull();
			expect(r.hash).toBe(commandHash("echo hi"));
			expect(typeof r.errorKind).toBe("string");
		}
	});

	test("no secret value from any known leak shape appears anywhere in the file", async () => {
		install(0);
		for (const p of SECRET_PAYLOADS) await systemOneGate(p.cmd, ON);
		const raw = readFileSync(join(dir, "audit", "system-one.jsonl"), "utf8");
		expect(raw.length).toBeGreaterThan(0);
		for (const p of SECRET_PAYLOADS)
			for (const secret of p.secrets) expect(raw).not.toContain(secret);
	});

	test("file is 0600 and its directory 0700 when created", async () => {
		install(0);
		await systemOneGate("echo hi", ON);
		expect(statSync(join(dir, "audit", "system-one.jsonl")).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "audit")).mode & 0o777).toBe(0o700);
	});
});

describe("logging changes no verdict", () => {
	const cases = ["echo UNSURE", "echo DANGER", "echo hello"];
	test("same run/guard with the log on and off", async () => {
		const out: Array<unknown[]> = [];
		for (const logOn of [true, false]) {
			if (logOn) process.env.EIGHT_DATA_DIR = dir;
			else Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR"); // NODE_ENV=test => log disabled
			_resetSystemOne();
			install(0);
			const rs = [];
			for (const c of cases) {
				const r = await systemOneGate(c, ON);
				rs.push({ run: r.run, verdict: r.guard?.verdict, pYes: r.guard?.pYes });
			}
			out.push(rs);
		}
		expect(out[0]).toEqual(out[1]);
		expect(lines()).toHaveLength(cases.length);
	});
});
