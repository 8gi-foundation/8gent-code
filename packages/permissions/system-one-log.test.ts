/**
 * System One verdict log (#3885): the record shape, the secret scrub, memo
 * hit/miss, and that logging changes no verdict.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";
import { PREVIEW_MAX, buildRecord, commandHash, commandPreview, systemOneLogPath } from "./system-one-log";

afterAll(cleanupTempDirs);

class Stub implements DecideBackend {
	readonly name = "stub";
	readonly model = "stub-model";
	calls = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.calls++;
		const yes = request.state.includes("DANGER") ? 0.95 : request.state.includes("UNSURE") ? 0.5 : 0.001;
		return {
			answers: [{ id: request.questions[0].id, kind: "noul", probabilities: { yes }, confidence: 0.9 }],
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
	return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

beforeEach(() => {
	_resetSystemOne();
	stub = new Stub();
	dir = tempDir("sys1log-");
	process.env.EIGHT_DATA_DIR = dir;
});
afterEach(() => {
	if (saved === undefined) delete process.env.EIGHT_DATA_DIR;
	else process.env.EIGHT_DATA_DIR = saved;
});

describe("record helpers", () => {
	test("hash is stable 16 hex and differs per command", () => {
		expect(commandHash("a")).toMatch(/^[0-9a-f]{16}$/);
		expect(commandHash("a")).toBe(commandHash("a"));
		expect(commandHash("a")).not.toBe(commandHash("b"));
	});
	test("preview scrubs secrets and is capped", () => {
		const p = commandPreview("curl -H 'x: AKIAIOSFODNN7EXAMPLE' https://x " + "y".repeat(200));
		expect(p).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(p.length).toBeLessThanOrEqual(PREVIEW_MAX);
	});
	test("NaN pYes becomes null; log is off under bun test without EIGHT_DATA_DIR", () => {
		const r = buildRecord("ls", { verdict: "block", pYes: Number.NaN, backend: "b", model: "m" }, "default", false);
		expect(r.pYes).toBeNull();
		expect(systemOneLogPath({ NODE_ENV: "test" })).toBeNull();
		expect(systemOneLogPath({ EIGHT_DATA_DIR: "/x" })).toBe("/x/audit/system-one.jsonl");
	});
});

describe("gate writes one record per judge call", () => {
	test("shape, raw pYes, verdict, backend/model, memo miss then hit", async () => {
		install(256);
		const cmd = "TODO_FILE=smoke.json bun src/cli.ts add 'UNSURE milk'";
		const a = await systemOneGate(cmd, ON);
		const b = await systemOneGate(cmd, ON);
		const recs = lines();
		expect(recs).toHaveLength(2);
		expect(Object.keys(recs[0]).sort()).toEqual(
			["backend", "hash", "memoHit", "model", "pYes", "preview", "thresholds", "timestamp", "verdict"].sort(),
		);
		expect(recs[0]).toMatchObject({
			hash: commandHash(cmd),
			pYes: 0.5,
			verdict: "escalate",
			backend: "stub",
			model: "stub-model",
			memoHit: false,
		});
		expect(recs[1].memoHit).toBe(true);
		expect(stub.calls).toBe(1);
		expect(a.run).toBe(b.run);
	});
	test("raw command text with a secret never reaches the file", async () => {
		install(0);
		await systemOneGate("echo AKIAIOSFODNN7EXAMPLE UNSURE", ON);
		expect(readFileSync(join(dir, "audit", "system-one.jsonl"), "utf8")).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});
});

describe("logging changes no verdict", () => {
	const cases = ["echo UNSURE", "echo DANGER", "echo hello"];
	test("same run/guard with the log on and off", async () => {
		const out: Array<unknown[]> = [];
		for (const logOn of [true, false]) {
			if (logOn) process.env.EIGHT_DATA_DIR = dir;
			else {
				delete process.env.EIGHT_DATA_DIR; // NODE_ENV=test => log disabled
			}
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
