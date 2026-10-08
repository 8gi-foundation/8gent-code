import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Baseline,
	DONE_GATE_TAG,
	baselineCheck,
	detectProjectCheck,
	doneGateAttempts,
	doneGateTimeoutSec,
	failureSignatures,
	finishWithProjectCheck,
	newFailures,
	projectFingerprint,
	readCheck,
	verdictNotice,
} from "./done-gate";

const dirs: string[] = [];
const dir = () => {
	const d = mkdtempSync(join(tmpdir(), "donegate-unit-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RUST_RED =
	"Exit code 101:\n\n   Compiling ex v0.1.0\nerror[E0308]: mismatched types\n --> src/lib.rs:1:40\nerror: could not compile `ex` (lib) due to 1 previous error\n";

describe("detectProjectCheck", () => {
	test("Cargo.toml -> cargo test", () => {
		const d = dir();
		writeFileSync(join(d, "Cargo.toml"), "[package]\nname='x'\n");
		expect(detectProjectCheck(d)).toBe("cargo test");
	});
	test("package.json test script -> its runner", () => {
		const d = dir();
		writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
		expect(detectProjectCheck(d)).toBe("bun run test");
	});
	test("go.mod -> go test ./...", () => {
		const d = dir();
		writeFileSync(join(d, "go.mod"), "module x\n");
		expect(detectProjectCheck(d)).toBe("go test ./...");
	});
	test("nothing known -> null", () => {
		expect(detectProjectCheck(dir())).toBeNull();
	});
});

describe("readCheck", () => {
	test("clean exit is green", () => {
		expect(readCheck("running 1 test\ntest adds ... ok", 300).kind).toBe("pass");
	});
	test("non-zero exit is red and names rustc's diagnostic", () => {
		const r = readCheck(RUST_RED, 300);
		expect(r.kind).toBe("fail");
		if (r.kind === "fail") expect(r.firstFailure).toBe("error[E0308]: mismatched types");
	});
	test("a signal kill is red", () => {
		expect(readCheck("Exit code null:\nkilled", 300).kind).toBe("fail");
	});
	test("runner missing, timeout, or gate marker is unverified, never green", () => {
		expect(readCheck("Exit code 127:\nsh: cargo: command not found", 300).kind).toBe("unverified");
		expect(readCheck("TIMEOUT after 300s. Partial output:", 300).kind).toBe("unverified");
		expect(readCheck("[PERMISSION DENIED] run_command", 300).kind).toBe("unverified");
		expect(readCheck("", 300).kind).toBe("unverified");
	});
});

describe("env knobs", () => {
	test("attempts default 2, clamp 0..5, junk falls back", () => {
		expect(doneGateAttempts({})).toBe(2);
		expect(doneGateAttempts({ EIGHT_DONE_GATE_ATTEMPTS: "0" })).toBe(0);
		expect(doneGateAttempts({ EIGHT_DONE_GATE_ATTEMPTS: "99" })).toBe(5);
		expect(doneGateAttempts({ EIGHT_DONE_GATE_ATTEMPTS: "-1" })).toBe(2);
	});
	test("timeout default and ceiling 300", () => {
		expect(doneGateTimeoutSec({})).toBe(300);
		expect(doneGateTimeoutSec({ EIGHT_DONE_GATE_TIMEOUT_SEC: "60" })).toBe(60);
		expect(doneGateTimeoutSec({ EIGHT_DONE_GATE_TIMEOUT_SEC: "9000" })).toBe(300);
	});
});

describe("projectFingerprint", () => {
	test("changes when a source file changes, ignores build output", () => {
		const d = dir();
		mkdirSync(join(d, "src"));
		mkdirSync(join(d, "target"));
		writeFileSync(join(d, "src", "lib.rs"), "a");
		const a = projectFingerprint(d);
		writeFileSync(join(d, "target", "out"), "build artefact");
		expect(projectFingerprint(d)).toBe(a);
		writeFileSync(join(d, "src", "lib.rs"), "ab");
		expect(projectFingerprint(d)).not.toBe(a);
	});
});

const CARGO_TEST_RED =
	"Exit code 101:\nrunning 1 test\ntest adds ... FAILED\n\nfailures:\nerror: test failed, to rerun pass `--test add`\n";

describe("failureSignatures / newFailures", () => {
	test("rustc errors keep the file, drop the line number", () => {
		const a = failureSignatures("error[E0308]: mismatched types\n --> src/lib.rs:1:40\n");
		const b = failureSignatures("error[E0308]: mismatched types\n --> src/lib.rs:9:2\n");
		expect([...a.keys()]).toEqual(["rustc [E0308]: mismatched types @ src/lib.rs"]);
		expect(newFailures(a, b)).toEqual([]);
	});
	test("cargo, bun, go and tsc failures are recognised", () => {
		const sigs = failureSignatures(
			[
				"test adds ... FAILED",
				"(fail) add zero [0.12ms]",
				"--- FAIL: TestAdd (0.00s)",
				"src/a.ts(3,5): error TS2322: Type 'string' is not assignable",
			].join("\n"),
		);
		expect([...sigs.keys()]).toEqual([
			"cargo test adds",
			"bun add zero",
			"go TestAdd",
			"tsc src/a.ts TS2322: Type 'string' is not assignable",
		]);
	});
	test("a second copy of the same failure is new", () => {
		const one = failureSignatures("(fail) x");
		const two = failureSignatures("(fail) x\n(fail) x");
		expect(newFailures(one, two)).toEqual(["bun x"]);
		expect(newFailures(two, one)).toEqual([]);
	});
});

describe("baselineCheck", () => {
	test("runs the detected check once; nothing when off or unknown", async () => {
		const d = dir();
		writeFileSync(join(d, "Cargo.toml"), "[package]\nname='x'\n");
		const ran: string[] = [];
		const run = async (c: string) => {
			ran.push(c);
			return CARGO_TEST_RED;
		};
		const b = await baselineCheck({ cwd: d, run, env: {} });
		expect(ran).toEqual(["cargo test"]);
		expect(b.command).toBe("cargo test");
		expect(
			(await baselineCheck({ cwd: d, run, env: { EIGHT_DONE_GATE: "0" } })).command,
		).toBeNull();
		expect((await baselineCheck({ cwd: dir(), run, env: {} })).command).toBeNull();
		expect(ran).toHaveLength(1);
	});
});

const base = (output: string): Baseline => {
	const read = readCheck(output, 300);
	return {
		command: "cargo test",
		outcome: { read, signatures: read.kind === "fail" ? failureSignatures(output) : new Map() },
	};
};
const GREEN = base("running 1 test\ntest adds ... ok");

describe("finishWithProjectCheck", () => {
	test("green before, red after, then fixed: pass after one fix round, failure fed back", async () => {
		const outputs = [RUST_RED, "test result: ok"];
		const sent: string[] = [];
		const v = await finishWithProjectCheck({
			baseline: GREEN,
			changed: true,
			finalText: "DONE: first",
			run: async () => outputs.shift() as string,
			chat: async (m) => {
				sent.push(m);
				return "DONE: fixed";
			},
			env: {},
		});
		expect(v.status).toBe("pass");
		expect(v.fixRounds).toBe(1);
		expect(v.finalText).toBe("DONE: fixed");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain(DONE_GATE_TAG);
		expect(sent[0]).toContain("error[E0308]: mismatched types");
		expect(verdictNotice(v)).toBeNull();
	});

	test("still worse after the budget: fail, exactly `attempts` fix rounds", async () => {
		let runs = 0;
		let chats = 0;
		const v = await finishWithProjectCheck({
			baseline: GREEN,
			changed: true,
			finalText: "DONE",
			run: async () => {
				runs++;
				return RUST_RED;
			},
			chat: async () => {
				chats++;
				return "DONE: tried";
			},
			env: { EIGHT_DONE_GATE_ATTEMPTS: "2" },
		});
		expect(v.status).toBe("fail");
		expect(chats).toBe(2);
		expect(runs).toBe(3);
		expect(v.detail).toContain("cargo test");
		expect(verdictNotice(v)).toContain("FAILED");
	});

	test("red before, same failures after: pre-existing, not sent back", async () => {
		let chats = 0;
		const v = await finishWithProjectCheck({
			baseline: base(CARGO_TEST_RED),
			changed: true,
			finalText: "DONE: docs",
			run: async () => CARGO_TEST_RED,
			chat: async () => {
				chats++;
				return "";
			},
			env: {},
		});
		expect(v.status).toBe("pre-existing");
		expect(chats).toBe(0);
		expect(verdictNotice(v)).toContain("pre-existing failures, not caused by this run");
	});

	test("red before, new failures after: sent back naming the new ones", async () => {
		const sent: string[] = [];
		const v = await finishWithProjectCheck({
			baseline: base(CARGO_TEST_RED),
			changed: true,
			finalText: "DONE",
			run: async () => RUST_RED,
			chat: async (m) => {
				sent.push(m);
				return "DONE";
			},
			env: { EIGHT_DONE_GATE_ATTEMPTS: "1" },
		});
		expect(v.status).toBe("fail");
		expect(sent[0]).toContain("these failures are new: rustc [E0308]: mismatched types");
	});

	test("baseline unverified: result unverified, no check run, visible notice", async () => {
		const never = async () => {
			throw new Error("must not run");
		};
		const v = await finishWithProjectCheck({
			baseline: base("TIMEOUT after 300s."),
			changed: true,
			finalText: "DONE",
			run: never,
			chat: never,
			env: {},
		});
		expect(v.status).toBe("unverified");
		expect(verdictNotice(v)).toContain("NOT VERIFIED");
		expect(verdictNotice(v)).toContain("before the run");
	});

	test("after-check timeout is unverified and does not loop", async () => {
		let chats = 0;
		const v = await finishWithProjectCheck({
			baseline: GREEN,
			changed: true,
			finalText: "DONE",
			run: async () => "TIMEOUT after 300s.",
			chat: async () => {
				chats++;
				return "";
			},
			env: {},
		});
		expect(v.status).toBe("unverified");
		expect(chats).toBe(0);
		expect(verdictNotice(v)).toContain("NOT VERIFIED: `cargo test` did not finish in 300s");
	});

	test("unchanged project or no baseline command: skipped, nothing run", async () => {
		const never = async () => {
			throw new Error("must not run");
		};
		for (const [baseline, changed] of [
			[GREEN, false],
			[{ command: null }, true],
		] as const) {
			const v = await finishWithProjectCheck({
				baseline,
				changed,
				finalText: "DONE",
				run: never,
				chat: never,
				env: {},
			});
			expect(v.status).toBe("skipped");
		}
	});
});

describe("finishWithProjectCheck, red to red without recognised failures", () => {
	const never = async () => {
		throw new Error("must not chat");
	};
	const FREE = "Exit code 1:\nSome specs did not pass\n";
	for (const [label, before, after] of [
		["neither side parsed", FREE, FREE],
		["before not parsed", FREE, CARGO_TEST_RED],
		["after not parsed", CARGO_TEST_RED, FREE],
	] as const) {
		test(`${label}: unverified, not pre-existing, not sent back`, async () => {
			const v = await finishWithProjectCheck({
				baseline: base(before),
				changed: true,
				finalText: "DONE",
				run: async () => after,
				chat: never,
				env: {},
			});
			expect(v.status).toBe("unverified");
			expect(verdictNotice(v)).toContain(
				"NOT VERIFIED: `cargo test` was already failing before this run; could not tell whether this run added failures",
			);
		});
	}
});
